import { snapshotBoundedPolicyData } from "./policy-input-snapshot.js";

import type {
  PolicyCancellationCause,
  PolicyDecision,
  PolicyEngine,
  PolicyEvaluationOptions,
  PolicyRequest,
  PolicyStopReason
} from "./contracts.js";

const DEFAULT_POLICY_TIMEOUT_MS = 5_000;

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


function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

export function snapshotPolicyRequest(request: PolicyRequest): PolicyRequest | undefined {
  try {
    return snapshotBoundedPolicyData(request) as PolicyRequest | undefined;
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

export function isValidPolicyDecision(value: unknown): value is PolicyDecision {
  return isPlainRecord(value) &&
    (value.effect === "allow" || value.effect === "deny") &&
    isNonEmptyString(value.reason);
}

export function snapshotPolicyDecision(value: unknown): PolicyDecision | undefined {
  try {
    if (!isValidPolicyDecision(value)) return undefined;
    return Object.freeze({ effect: value.effect, reason: value.reason });
  } catch {
    return undefined;
  }
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
  const reason: unknown = signal.reason;
  if (typeof reason === "object" && reason !== null && "code" in reason) {
    const code = reason.code;
    if (code === "CALLER_CANCELLED" || code === "POLICY_TIMEOUT" ||
        code === "RUNTIME_SHUTDOWN" || code === "PARENT_CANCELLED") return code;
  }
  return fallback;
}

/**
 * This wrapper is cooperative only. A delegate that ignores AbortSignal may
 * continue executing after this method returns. Use a process boundary when
 * hard execution termination is required.
 */
export class FailClosedPolicyEngine implements PolicyEngine {
  private shuttingDown = false;
  private readonly activeStops = new Set<(reason: PolicyStopReason) => void>();

  constructor(
    private readonly delegate: PolicyEngine,
    private readonly timeoutMs = DEFAULT_POLICY_TIMEOUT_MS
  ) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError("Policy evaluation timeout must be a positive finite number.");
    }
  }

  async evaluate(
    request: PolicyRequest,
    options?: PolicyEvaluationOptions
  ): Promise<PolicyDecision> {
    if (this.shuttingDown) return deny("Policy runtime is shutting down; access denied.");
    const input = snapshotPolicyRequest(request);
    if (!input) return deny("Policy request cannot be safely snapshotted; access denied.");
    if (!isValidPolicyRequest(input)) return deny("Policy request is invalid; access denied.");

    if (options?.signal?.aborted) {
      return deny(cancellationMessage(reasonFromSignal(options.signal, "CALLER_CANCELLED")));
    }
    if (options?.parentSignal?.aborted) {
      return deny(cancellationMessage("PARENT_CANCELLED"));
    }
    if (options?.deadlineAt !== undefined &&
        (typeof options.deadlineAt !== "number" || !Number.isFinite(options.deadlineAt))) {
      return deny("Policy deadline is invalid; access denied.");
    }

    const remainingDeadlineMs = options?.deadlineAt === undefined
      ? this.timeoutMs
      : options.deadlineAt - Date.now();
    if (remainingDeadlineMs <= 0) return deny(cancellationMessage("POLICY_TIMEOUT"));

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

    this.activeStops.add(stop);

    if (options?.signal) {
      callerAbort = () => stop(reasonFromSignal(options.signal!, "CALLER_CANCELLED"));
      options.signal.addEventListener("abort", callerAbort, { once: true });
    }
    if (options?.parentSignal) {
      parentAbort = () => stop("PARENT_CANCELLED");
      options.parentSignal.addEventListener("abort", parentAbort, { once: true });
    }

    timeout = setTimeout(() => stop("POLICY_TIMEOUT"), effectiveTimeoutMs);

    try {
      if (options?.signal?.aborted) stop(reasonFromSignal(options.signal, "CALLER_CANCELLED"));
      if (options?.parentSignal?.aborted) stop("PARENT_CANCELLED");

      const delegateOptions: PolicyEvaluationOptions = {
        signal: controller.signal,
        ...(options?.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt })
      };
      const evaluation = Promise.resolve()
        .then(() => {
          if (controller.signal.aborted) return undefined;
          return this.delegate.evaluate(input, delegateOptions);
        })
        .then((result) => {
          if (candidateFrozen) return undefined;
          const decision = snapshotPolicyDecision(result) ??
            deny("Policy evaluator returned an invalid decision; access denied.");
          candidateFrozen = true;
          return decision;
        });
      const result = await Promise.race([evaluation, aborted]);
      if (stopReason !== undefined) return deny(cancellationMessage(stopReason));
      return result ?? deny("Policy evaluator returned an invalid decision; access denied.");
    } catch {
      return stopReason !== undefined
        ? deny(cancellationMessage(stopReason))
        : deny("Policy evaluation failed; access denied.");
    } finally {
      this.activeStops.delete(stop);
      if (timeout !== undefined) clearTimeout(timeout);
      if (callerAbort && options?.signal) {
        options.signal.removeEventListener("abort", callerAbort);
      }
      if (parentAbort && options?.parentSignal) {
        options.parentSignal.removeEventListener("abort", parentAbort);
      }
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const stop of [...this.activeStops]) stop("RUNTIME_SHUTDOWN");
    await this.delegate.shutdown?.();
  }
}
