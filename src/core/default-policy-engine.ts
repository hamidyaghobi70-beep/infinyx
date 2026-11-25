import type { PolicyDecision, PolicyEngine, PolicyRequest } from "./contracts.js";

/**
 * Safe default: no action is authorized until an explicit policy implementation
 * is injected. This is not an authentication or identity provider.
 */
export class DefaultDenyPolicyEngine implements PolicyEngine {
  async evaluate(_request: PolicyRequest): Promise<PolicyDecision> {
    return {
      effect: "deny",
      reason: "No explicit authorization policy has been configured."
    };
  }
}
