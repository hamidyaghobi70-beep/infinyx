import type { PolicyDecision, PolicyEngine, PolicyRequest } from "./contracts.js";

const DEFAULT_POLICY_TIMEOUT_MS = 5_000;

function deny(reason: string): PolicyDecision {
  return { effect: "deny", reason };
}

/**
 * Wraps an injected evaluator so failures and deadlines can never become an
 * authorization grant. This evaluates policy only; it does not execute actions.
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
      return await Promise.race([
        Promise.resolve().then(() => this.delegate.evaluate(request)),
        new Promise<PolicyDecision>((resolve) => {
          timeout = setTimeout(
            () => resolve(deny("Policy evaluation timed out; access denied.")),
            this.timeoutMs
          );
        })
      ]);
    } catch {
      return deny("Policy evaluation failed; access denied.");
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
}
