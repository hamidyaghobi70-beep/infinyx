import type {
  PolicyDecision,
  PolicyEngine,
  PolicyRequest
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

/** Reject accessors, symbols, cycles, class instances and non-data values. */
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
    if (!descriptor || !("value" in descriptor) ||
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

/** Clone before calling policy code, then recursively freeze the detached graph. */
function snapshotRequest(request: PolicyRequest): PolicyRequest | undefined {
  if (!isSafeData(request)) return undefined;
  try {
    return freezeDeep(structuredClone(request));
  } catch {
    return undefined;
  }
}

function isValidPolicyRequest(value: unknown): value is PolicyRequest {
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

function snapshotDecision(value: unknown): PolicyDecision | undefined {
  if (!isPlainRecord(value) ||
      (value.effect !== "allow" && value.effect !== "deny") ||
      !isNonEmptyString(value.reason)) return undefined;
  // Copy only the contract fields: never expose the evaluator's mutable object.
  return Object.freeze({ effect: value.effect, reason: value.reason });
}

/**
 * Timeout aborts the evaluator signal before returning deny. Cancellation is
 * cooperative, not forced termination: a delegate that ignores AbortSignal
 * may continue running in this process. Use a worker/process boundary when
 * hard resource termination is required.
 */
export class FailClosedPolicyEngine implements PolicyEngine {
  constructor(
    private readonly delegate: PolicyEngine,
    private readonly timeoutMs = DEFAULT_POLICY_TIMEOUT_MS
  ) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError("Policy evaluation timeout must be a positive finite number.");
    }
  }

  async evaluate(request: PolicyRequest): Promise<PolicyDecision> {
    if (!isValidPolicyRequest(request)) return deny("Policy request is invalid; access denied.");
    const input = snapshotRequest(request);
    if (!input) return deny("Policy request cannot be safely snapshotted; access denied.");

    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error("Policy evaluation timed out."));
        reject(new Error("Policy evaluation timed out."));
      }, this.timeoutMs);
    });

    try {
      const evaluation = Promise.resolve().then(() =>
        this.delegate.evaluate(input, { signal: controller.signal })
      );
      const result: unknown = await Promise.race([evaluation, deadline]);
      return snapshotDecision(result) ??
        deny("Policy evaluator returned an invalid decision; access denied.");
    } catch {
      return timedOut
        ? deny("Policy evaluation timed out; access denied.")
        : deny("Policy evaluation failed; access denied.");
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
}
