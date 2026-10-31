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
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["invalid effect", { effect: "permit", reason: "not a valid effect" }],
    ["missing effect", { reason: "missing effect" }],
    ["missing reason", { effect: "allow" }],
    ["empty reason", { effect: "allow", reason: "   " }],
    ["array", []],
    ["primitive", "allow"]
  ])("converts %s evaluator output into deny", async (_label, output) => {
    const policy = new FailClosedPolicyEngine({
      evaluate: async () => output as never
    });

    await expect(policy.evaluate(request)).resolves.toMatchObject({ effect: "deny" });
  });

  it.each([
    ["missing actor", { action: "record.read", resource: "record:123" }],
    ["blank actor", { actorId: "  ", action: "record.read", resource: "record:123" }],
    ["missing action", { actorId: "actor-1", resource: "record:123" }],
    ["blank action", { actorId: "actor-1", action: " ", resource: "record:123" }],
    ["missing resource", { actorId: "actor-1", action: "record.read" }],
    ["blank resource", { actorId: "actor-1", action: "record.read", resource: " " }],
    ["null context", { actorId: "actor-1", action: "record.read", resource: "record:123", context: null }],
    ["array context", { actorId: "actor-1", action: "record.read", resource: "record:123", context: [] }],
    ["array attributes", { actorId: "actor-1", action: "record.read", resource: "record:123", context: { attributes: [] } }],
    ["blank attribute key", { actorId: "actor-1", action: "record.read", resource: "record:123", context: { attributes: { " ": "value" } } }]
  ])("denies malformed policy request: %s", async (_label, invalidRequest) => {
    let evaluatorCalls = 0;
    const policy = new FailClosedPolicyEngine({
      evaluate: async () => {
        evaluatorCalls += 1;
        return { effect: "allow", reason: "should not be reached" };
      }
    });

    await expect(policy.evaluate(invalidRequest as never)).resolves.toMatchObject({ effect: "deny" });
    expect(evaluatorCalls).toBe(0);
  });

  it("accepts the documented context envelope with opaque attributes", async () => {
    const evaluator = vi.fn(async () => ({ effect: "allow" as const, reason: "context accepted" }));
    const policy = new FailClosedPolicyEngine({ evaluate: evaluator });
    const contextualRequest: PolicyRequest = {
      ...request,
      context: { attributes: { tenant: "tenant-a", clearance: 3 } }
    };

    await expect(policy.evaluate(contextualRequest)).resolves.toEqual({
      effect: "allow",
      reason: "context accepted"
    });
    expect(evaluator).toHaveBeenCalledWith(contextualRequest);
  });

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
      evaluate: () => new Promise<never>(() => undefined)
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
