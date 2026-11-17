import type {
  PolicyCancellationCause,
  PolicyDecision,
  PolicyEngine,
  PolicyEvaluationOptions,
  PolicyRequest,
  PolicyStopReason
} from "./contracts.js";

const DEFAULT_POLICY_TIMEOUT_MS = 5_000;
const MAX_ACTIVE_POLICY_EVALUATIONS = 512;

function deny(reason: string): PolicyDecision {
  return Object.freeze({ effect: "deny", reason });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSafeData(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean" ||
      typeof value === "undefined") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  if (!Array.isArray(value) && !isPlainRecord(value)) return false;
  ancestors.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === "symbol" || (Array.isArray(value) && key === "length")) continue;
    const descriptor = descriptors[key as keyof typeof descriptors];
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor) ||
        !isSafeData(descriptor.value, ancestors)) {
      ancestors.delete(value);
      return false;
    }
  }
  ancestors.delete(value);
  return true;
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

export function snapshotPolicyRequest(request: PolicyRequest): PolicyRequest | undefined {
  try {
    if (!isSafeData(request)) return undefined;
    return freezeDeep(structuredClone(request));
  } catch {
    return undefined;
  }
}

export function isValidPolicyRequest(value: unknown): value is PolicyRequest {
  if (!isPlainRecord(value)) return false;
  if (!isNonEmptyString(value.actorId) || !isNonEmptyString(value.action) ||
      !isNonEmptyString(value.resource)) return false;
  if (value.context === undefined) return true;
  if (!isPlainRecord(value.context)) return false;
  const attributes = value.context.attributes;
  return attributes === undefined ||
    (isPlainRecord(attributes) &&
      Object.keys(attributes).every((key) => key.trim().length > 0));
}

/**
 * Read a policy result through own property descriptors. Never dereference
 * untrusted properties: accessor getters must not execute at the trust boundary.
 *
 * Proxy reflection traps cannot be detected or prevented by JavaScript; any
 * trap failure is caught by the caller and converted into a deny decision.
 */
export function snapshotPolicyDecision(value: unknown): PolicyDecision | undefined {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== 2 || !keys.includes("effect") || !keys.includes("reason")) {
      return undefined;
    }

    const effectDescriptor = descriptors.effect;
    const reasonDescriptor = descriptors.reason;
    if (!effectDescriptor || !effectDescriptor.enumerable || !("value" in effectDescriptor) ||
        !reasonDescriptor || !reasonDescriptor.enumerable || !("value" in reasonDescriptor)) {
      return undefined;
    }

    const effect: unknown = effectDescriptor.value;
    const reason: unknown = reasonDescriptor.value;
    if ((effect !== "allow" && effect !== "deny") || !isNonEmptyString(reason)) {
      return undefined;
    }

    return Object.freeze({ effect, reason });
  } catch {
    return undefined;
  }
}

export function isValidPolicyDecision(value: unknown): value is PolicyDecision {
  return snapshotPolicyDecision(value) !== undefined;
}

function cancellationMessage(reason: PolicyStopReason): string {
  switch (reason) {
    case "CALLER_CANCELLED":
      return "Policy evaluation cancelled by caller; access denied.";
    case "PARENT_CANCELLED":
      return "Parent operation cancelled policy evaluation; access denied.";
    case "RUNTIME_SHUTDOWN":
      return "Runtime shutdown cancelled policy evaluation; access denied.";
    case "POLICY_TIMEOUT":
      return "Policy evaluation timed out; access denied.";
  }
}

function reasonFromSignal(signal: AbortSignal, fallback: PolicyStopReason): PolicyStopReason {
  try {
    const reason: unknown = signal.reason;
    if (typeof reason === "object" && reason !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(reason, "code");
      if (descriptor && "value" in descriptor) {
        const code: unknown = descriptor.value;
        if (code === "CALLER_CANCELLED" || code === "POLICY_TIMEOUT" ||
            code === "RUNTIME_SHUTDOWN" || code === "PARENT_CANCELLED") return code;
      }
    }
  } catch {
    // Abort reasons are caller-controlled; hostile reflection must not escape
    // the cancellation boundary or prevent the fail-closed fallback.
  }
  return fallback;
}

/**
 * This wrapper is cooperative only. A delegate that ignores AbortSignal may
 * continue executing after this method returns. Use a process boundary when
 * hard execution termination is required.
 */
function capturePolicyMethod<T extends (...args: never[]) => unknown>(
  target: unknown,
  name: string,
  optional = false
): T | undefined {
  try {
    if ((typeof target !== "object" && typeof target !== "function") || target === null) {
      throw new Error("Invalid policy delegate.");
    }
    let current: object | null = target as object;
    while (current !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(current, name);
      if (descriptor) {
        if (!Object.prototype.hasOwnProperty.call(descriptor, "value")) {
          throw new Error("Policy methods must be data properties.");
        }
        if (descriptor.value === undefined && optional) return undefined;
        if (typeof descriptor.value !== "function") {
          throw new Error("Policy method is not callable.");
        }
        return Function.prototype.bind.call(descriptor.value, target) as T;
      }
      current = Object.getPrototypeOf(current) as object | null;
    }
    if (optional) return undefined;
  } catch {
    throw new TypeError("Policy delegate must expose stable data methods.");
  }
  throw new TypeError("Policy delegate must expose stable data methods.");
}

export class FailClosedPolicyEngine implements PolicyEngine {
  private shuttingDown = false;
  private readonly activeStops = new Set<(reason: PolicyStopReason) => void>();
  private readonly activeEvaluations = new Set<Promise<unknown>>();
  private shutdownPromise: Promise<void> | undefined;
  private readonly delegateEvaluate: PolicyEngine["evaluate"];
  private readonly delegateShutdown: PolicyEngine["shutdown"];

  constructor(
    delegate: PolicyEngine,
    private readonly timeoutMs = DEFAULT_POLICY_TIMEOUT_MS
  ) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError("Policy evaluation timeout must be a positive finite number.");
    }
    this.delegateEvaluate = capturePolicyMethod<PolicyEngine["evaluate"]>(delegate, "evaluate")!;
    this.delegateShutdown = capturePolicyMethod<NonNullable<PolicyEngine["shutdown"]>>(delegate, "shutdown", true);
  }

  async evaluate(
    request: PolicyRequest,
    options?: PolicyEvaluationOptions
  ): Promise<PolicyDecision> {
    if (this.shuttingDown) return deny("Policy runtime is shutting down; access denied.");
    const input = snapshotPolicyRequest(request);
    if (!input) return deny("Policy request cannot be safely snapshotted; access denied.");
    if (!isValidPolicyRequest(input)) return deny("Policy request is invalid; access denied.");

    // Capture every caller-controlled option exactly once. Accessors and Proxy
    // traps are untrusted input and must never escape this boundary.
    let callerSignal: AbortSignal | undefined;
    let parentSignal: AbortSignal | undefined;
    let deadlineAt: number | undefined;
    try {
      callerSignal = options?.signal;
      parentSignal = options?.parentSignal;
      deadlineAt = options?.deadlineAt;
      if (deadlineAt !== undefined && !Number.isFinite(deadlineAt)) {
        return deny("Policy evaluation deadline is invalid; access denied.");
      }
      if (callerSignal !== undefined &&
          (typeof callerSignal.aborted !== "boolean" ||
           typeof callerSignal.addEventListener !== "function" ||
           typeof callerSignal.removeEventListener !== "function")) {
        return deny("Caller cancellation signal is invalid; access denied.");
      }
      if (parentSignal !== undefined &&
          (typeof parentSignal.aborted !== "boolean" ||
           typeof parentSignal.addEventListener !== "function" ||
           typeof parentSignal.removeEventListener !== "function")) {
        return deny("Parent cancellation signal is invalid; access denied.");
      }
      if (callerSignal?.aborted) {
        return deny(cancellationMessage(reasonFromSignal(callerSignal, "CALLER_CANCELLED")));
      }
      if (parentSignal?.aborted) {
        return deny(cancellationMessage("PARENT_CANCELLED"));
      }
    } catch {
      return deny("Policy evaluation cancellation options are invalid; access denied.");
    }

    const remainingDeadlineMs = deadlineAt === undefined
      ? this.timeoutMs
      : deadlineAt - Date.now();
    if (remainingDeadlineMs <= 0) return deny(cancellationMessage("POLICY_TIMEOUT"));

    if (this.activeEvaluations.size >= MAX_ACTIVE_POLICY_EVALUATIONS) {
      return deny("Policy evaluation concurrency limit exceeded; access denied.");
    }

    const effectiveTimeoutMs = Math.min(this.timeoutMs, remainingDeadlineMs);
    const controller = new AbortController();
    let stopReason: PolicyStopReason | undefined;
    let candidateFrozen = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let callerAbort: (() => void) | undefined;
    let parentAbort: (() => void) | undefined;
    let resolveAbort!: (decision: PolicyDecision) => void;
    const aborted = new Promise<PolicyDecision>((resolve) => {
      resolveAbort = resolve;
    });

    const stop = (reason: PolicyStopReason): void => {
      if (controller.signal.aborted || candidateFrozen) return;
      candidateFrozen = true;
      stopReason = reason;
      const cause: PolicyCancellationCause = {
        code: reason,
        message: cancellationMessage(reason)
      };
      controller.abort(cause);
      resolveAbort(deny(cause.message));
    };

    const cleanup = (): void => {
      this.activeStops.delete(stop);
      if (timeout !== undefined) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      if (callerAbort && callerSignal) {
        try { callerSignal.removeEventListener("abort", callerAbort); } catch {
          // Cleanup failure must not replace the fail-closed decision.
        }
      }
      if (parentAbort && parentSignal) {
        try { parentSignal.removeEventListener("abort", parentAbort); } catch {
          // Keep caller and parent cleanup independent.
        }
      }
    };

    this.activeStops.add(stop);
    try {
      if (callerSignal) {
        callerAbort = () => stop(reasonFromSignal(callerSignal!, "CALLER_CANCELLED"));
        callerSignal.addEventListener("abort", callerAbort, { once: true });
      }
      if (parentSignal) {
        parentAbort = () => stop("PARENT_CANCELLED");
        parentSignal.addEventListener("abort", parentAbort, { once: true });
      }
      timeout = setTimeout(() => stop("POLICY_TIMEOUT"), effectiveTimeoutMs);

      // Close the registration race: a signal may abort immediately around
      // listener installation, so re-check both captured signals.
      if (callerSignal?.aborted) stop(reasonFromSignal(callerSignal, "CALLER_CANCELLED"));
      if (parentSignal?.aborted) stop("PARENT_CANCELLED");
    } catch {
      cleanup();
      return deny("Policy evaluation cancellation setup failed; access denied.");
    }

    try {
      const delegateOptions: PolicyEvaluationOptions = {
        signal: controller.signal,
        ...(deadlineAt === undefined ? {} : { deadlineAt })
      };
      const evaluation = Promise.resolve()
        .then(() => {
          if (controller.signal.aborted) return undefined;
          return this.delegateEvaluate(input, delegateOptions);
        })
        .then((result) => {
          if (candidateFrozen) return undefined;
          const decision = snapshotPolicyDecision(result) ??
            deny("Policy evaluator returned an invalid decision; access denied.");
          candidateFrozen = true;
          return decision;
        });
      this.activeEvaluations.add(evaluation);
      void evaluation.then(
        () => { this.activeEvaluations.delete(evaluation); },
        () => { this.activeEvaluations.delete(evaluation); }
      );
      const result = await Promise.race([evaluation, aborted]);
      if (stopReason !== undefined) return deny(cancellationMessage(stopReason));
      return result ?? deny("Policy evaluator returned an invalid decision; access denied.");
    } catch {
      return stopReason !== undefined
        ? deny(cancellationMessage(stopReason))
        : deny("Policy evaluation failed; access denied.");
    } finally {
      cleanup();
    }
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    for (const stop of [...this.activeStops]) stop("RUNTIME_SHUTDOWN");

    let delegateShutdown: Promise<void>;
    try {
      delegateShutdown = Promise.resolve(this.delegateShutdown?.());
    } catch (error) {
      this.shutdownPromise = Promise.reject(error);
      return this.shutdownPromise;
    }

    // The wrapper's cancellation race is not proof that delegate work settled.
    // Retain the underlying evaluation promises until they actually settle.
    const evaluations = [...this.activeEvaluations].map((evaluation) =>
      evaluation.then(() => undefined, () => undefined)
    );
    this.shutdownPromise = Promise.all([
      delegateShutdown,
      Promise.all(evaluations).then(() => undefined)
    ]).then(() => undefined);
    return this.shutdownPromise;
  }
}
