import type {
  PolicyDecision,
  PolicyEngine,
  PolicyRequest
} from "./contracts.js";

const DEFAULT_POLICY_TIMEOUT_MS = 5_000;

function deny(reason: string): PolicyDecision {
  return { effect: "deny", reason };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Validate the request before untrusted policy code receives it. */
export function isValidPolicyRequest(value: unknown): value is PolicyRequest {
  if (!isPlainRecord(value)) return false;
  if (!isNonEmptyString(value.actorId) ||
      !isNonEmptyString(value.action) ||
      !isNonEmptyString(value.resource)) return false;

  if (value.context === undefined) return true;
  if (!isPlainRecord(value.context)) return false;

  const context = value.context;
  if (context.attributes === undefined) return true;
  if (!isPlainRecord(context.attributes)) return false;

  return Object.keys(context.attributes).every((key) => key.trim().length > 0);
}

/** Validate evaluator output before a decision crosses the policy boundary. */
export function isValidPolicyDecision(value: unknown): value is PolicyDecision {
  return isPlainRecord(value) &&
    (value.effect === "allow" || value.effect === "deny") &&
    isNonEmptyString(value.reason);
}

/**
 * Wraps an injected evaluator so malformed inputs, failures, caller
 * cancellation, and deadlines can never become an authorization grant.
 * Evaluation only; no action execution occurs here.
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

  async evaluate(
    request: PolicyRequest,
    options?: { readonly signal?: AbortSignal }
  ): Promise<PolicyDecision> {
    if (!isValidPolicyRequest(request)) {
      return deny("Policy request is invalid; access denied.");
    }

    const callerSignal = options?.signal;
    if (callerSignal?.aborted) {
      return deny("Policy evaluation was cancelled; access denied.");
    }

    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let callerAbortListener: (() => void) | undefined;
    let resolveCancellation!: (decision: PolicyDecision) => void;

    const cancellation = new Promise<PolicyDecision>((resolve) => {
      resolveCancellation = resolve;
    });

    const cancel = (reason: "timeout" | "caller"): void => {
      if (controller.signal.aborted) return;
      controller.abort();
      resolveCancellation(
        reason === "timeout"
          ? deny("Policy evaluation timed out; access denied.")
          : deny("Policy evaluation was cancelled; access denied.")
      );
    };

    try {
      if (callerSignal) {
        callerAbortListener = () => cancel("caller");
        callerSignal.addEventListener("abort", callerAbortListener, { once: true });
        // Close the race between the initial check and listener registration.
        if (callerSignal.aborted) cancel("caller");
      }

      timeout = setTimeout(() => cancel("timeout"), this.timeoutMs);

      const evaluation = Promise.resolve().then(() => {
        // A caller may abort after listener registration but before this
        // microtask runs. In that case the evaluator must never be invoked.
        if (controller.signal.aborted) {
          return deny("Policy evaluation was cancelled; access denied.");
        }
        return this.delegate.evaluate(request, { signal: controller.signal });
      });

      const result: unknown = await Promise.race([evaluation, cancellation]);
      if (!isValidPolicyDecision(result)) {
        return deny("Policy evaluator returned an invalid decision; access denied.");
      }
      return result;
    } catch {
      return deny("Policy evaluation failed; access denied.");
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (callerSignal && callerAbortListener) {
        callerSignal.removeEventListener("abort", callerAbortListener);
      }
    }
  }
}
