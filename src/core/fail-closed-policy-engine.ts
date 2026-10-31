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
 * Wraps an injected evaluator so malformed inputs/outputs, failures, and
 * deadlines can never become an authorization grant. Evaluation only; no
 * action execution occurs here.
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
    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
      if (!isValidPolicyRequest(request)) {
        return deny("Policy request is invalid; access denied.");
      }

      const result: unknown = await Promise.race([
        Promise.resolve().then(() => this.delegate.evaluate(request)),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Policy evaluation timed out.")),
            this.timeoutMs
          );
        })
      ]);

      if (!isValidPolicyDecision(result)) {
        return deny("Policy evaluator returned an invalid decision; access denied.");
      }
      return result;
    } catch (error) {
      if (error instanceof Error && error.message === "Policy evaluation timed out.") {
        return deny("Policy evaluation timed out; access denied.");
      }
      return deny("Policy evaluation failed; access denied.");
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
}
