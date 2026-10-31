import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreEngine } from "../../src/core/core-engine.js";
import { FailClosedPolicyEngine } from "../../src/core/fail-closed-policy-engine.js";
import type { PolicyRequest } from "../../src/core/contracts.js";

const request: PolicyRequest = {
  actorId: "test-actor",
  action: "record.read",
  resource: "record:123"
};

afterEach(() => {
  vi.useRealTimers();
});

describe("FailClosedPolicyEngine", () => {
  it("preserves an explicit allow decision from the evaluator", async () => {
    const policy = new FailClosedPolicyEngine({
      evaluate: async () => ({ effect: "allow", reason: "Explicit test grant." })
    });

    await expect(policy.evaluate(request)).resolves.toEqual({
      effect: "allow",
      reason: "Explicit test grant."
    });
  });

  it("converts synchronous throws and rejected evaluations into deny decisions", async () => {
    const synchronous = new FailClosedPolicyEngine({
      evaluate: () => { throw new Error("sync evaluator failure"); }
    });
    const asynchronous = new FailClosedPolicyEngine({
      evaluate: async () => { throw new Error("async evaluator failure"); }
    });

    await expect(synchronous.evaluate(request)).resolves.toMatchObject({ effect: "deny" });
    await expect(asynchronous.evaluate(request)).resolves.toMatchObject({ effect: "deny" });
  });

  it("denies when an evaluator does not complete before the configured timeout", async () => {
    vi.useFakeTimers();
    const policy = new FailClosedPolicyEngine({
      evaluate: () => new Promise(() => undefined)
    }, 25);

    const decision = policy.evaluate(request);
    await vi.advanceTimersByTimeAsync(25);

    await expect(decision).resolves.toEqual({
      effect: "deny",
      reason: "Policy evaluation timed out; access denied."
    });
  });

  it("applies the fail-closed boundary to an injected CoreEngine policy", async () => {
    const engine = new CoreEngine({
      policy: { evaluate: async () => { throw new Error("policy unavailable"); } }
    });

    await expect(engine.policy.evaluate(request)).resolves.toMatchObject({ effect: "deny" });
  });

  it("rejects an invalid timeout configuration", () => {
    expect(() => new FailClosedPolicyEngine({ evaluate: async () => ({
      effect: "deny",
      reason: "unused"
    }) }, 0)).toThrow(/positive finite number/);
  });
});
