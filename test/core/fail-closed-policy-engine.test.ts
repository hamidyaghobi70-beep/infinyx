import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreEngine } from "../../src/core/core-engine.js";
import { FailClosedPolicyEngine } from "../../src/core/fail-closed-policy-engine.js";
import type {
  PolicyDecision,
  PolicyEvaluationOptions,
  PolicyRequest
} from "../../src/core/contracts.js";

const request: PolicyRequest = {
  actorId: "test-actor",
  action: "record.read",
  resource: "record:123"
};

const allow: PolicyDecision = {
  effect: "allow",
  reason: "Explicit test grant."
};

const denyDecision: PolicyDecision = {
  effect: "deny",
  reason: "Explicit test denial."
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("FailClosedPolicyEngine", () => {
  it("preserves an explicit allow decision", async () => {
    const policy = new FailClosedPolicyEngine({
      evaluate: async () => allow
    });
    await expect(policy.evaluate(request)).resolves.toEqual(allow);
  });

  it("preserves an explicit deny decision", async () => {
    const policy = new FailClosedPolicyEngine({
      evaluate: async () => denyDecision
    });
    await expect(policy.evaluate(request)).resolves.toEqual(denyDecision);
  });

  it("converts synchronous throws and rejected evaluations into deny", async () => {
    const synchronous = new FailClosedPolicyEngine({
      evaluate: () => { throw new Error("sync evaluator failure"); }
    });
    const asynchronous = new FailClosedPolicyEngine({
      evaluate: async () => { throw new Error("async evaluator failure"); }
    });
    await expect(synchronous.evaluate(request)).resolves.toMatchObject({ effect: "deny" });
    await expect(asynchronous.evaluate(request)).resolves.toMatchObject({ effect: "deny" });
  });

  it("passes an internal AbortSignal to the evaluator and aborts it on timeout", async () => {
    vi.useFakeTimers();
    let receivedSignal: AbortSignal | undefined;
    const policy = new FailClosedPolicyEngine({
      evaluate: (_input, options?: PolicyEvaluationOptions) => {
        receivedSignal = options?.signal;
        return new Promise<PolicyDecision>(() => undefined);
      }
    }, 25);

    const decision = policy.evaluate(request);
    await Promise.resolve();
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(receivedSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(25);
    await expect(decision).resolves.toEqual({
      effect: "deny",
      reason: "Policy evaluation timed out; access denied."
    });
    expect(receivedSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("denies caller cancellation and aborts the evaluator signal", async () => {
    let receivedSignal: AbortSignal | undefined;
    const caller = new AbortController();
    const policy = new FailClosedPolicyEngine({
      evaluate: (_input, options?: PolicyEvaluationOptions) => {
        receivedSignal = options?.signal;
        return new Promise<PolicyDecision>(() => undefined);
      }
    });

    const decision = policy.evaluate(request, { signal: caller.signal });
    await Promise.resolve();
    caller.abort();
    await expect(decision).resolves.toEqual({
      effect: "deny",
      reason: "Policy evaluation was cancelled; access denied."
    });
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("does not invoke the evaluator when the caller signal is already aborted", async () => {
    const caller = new AbortController();
    caller.abort();
    const evaluator = vi.fn(async () => allow);
    const policy = new FailClosedPolicyEngine({ evaluate: evaluator });

    await expect(policy.evaluate(request, { signal: caller.signal })).resolves.toMatchObject({
      effect: "deny"
    });
    expect(evaluator).not.toHaveBeenCalled();
  });

  it("does not invoke the evaluator if cancellation wins before its microtask starts", async () => {
    const caller = new AbortController();
    const evaluator = vi.fn(async () => allow);
    const policy = new FailClosedPolicyEngine({ evaluate: evaluator });

    const decision = policy.evaluate(request, { signal: caller.signal });
    caller.abort();
    await expect(decision).resolves.toMatchObject({ effect: "deny" });
    expect(evaluator).not.toHaveBeenCalled();
  });

  it("keeps late fulfillment from changing a timeout denial", async () => {
    vi.useFakeTimers();
    let resolveLate!: (value: PolicyDecision) => void;
    let receivedSignal: AbortSignal | undefined;
    const policy = new FailClosedPolicyEngine({
      evaluate: (_input, options) => {
        receivedSignal = options?.signal;
        return new Promise<PolicyDecision>((resolve) => { resolveLate = resolve; });
      }
    }, 10);

    const decision = policy.evaluate(request);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);
    await expect(decision).resolves.toMatchObject({ effect: "deny" });
    resolveLate(allow);
    await Promise.resolve();
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("consumes a late rejection after timeout without an unhandled rejection", async () => {
    vi.useFakeTimers();
    let rejectLate!: (reason: Error) => void;
    const policy = new FailClosedPolicyEngine({
      evaluate: () => new Promise<PolicyDecision>((_resolve, reject) => {
        rejectLate = reject;
      })
    }, 10);

    const decision = policy.evaluate(request);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);
    await expect(decision).resolves.toMatchObject({ effect: "deny" });
    rejectLate(new Error("late evaluator rejection"));
    await Promise.resolve();
    await Promise.resolve();
  });

  it("removes the caller abort listener and clears its timeout after completion", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const addSpy = vi.spyOn(caller.signal, "addEventListener");
    const removeSpy = vi.spyOn(caller.signal, "removeEventListener");
    const policy = new FailClosedPolicyEngine({
      evaluate: async () => allow
    }, 1_000);

    await expect(policy.evaluate(request, { signal: caller.signal })).resolves.toEqual(allow);
    expect(addSpy).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves the legacy evaluate(request) API", async () => {
    const evaluator = vi.fn(async (input: PolicyRequest) => ({
      effect: "allow" as const,
      reason: input.action
    }));
    const policy = new FailClosedPolicyEngine({ evaluate: evaluator });

    await expect(policy.evaluate(request)).resolves.toEqual({
      effect: "allow",
      reason: "record.read"
    });
    expect(evaluator).toHaveBeenCalledWith(request, expect.objectContaining({
      signal: expect.any(AbortSignal)
    }));
  });

  it("applies the fail-closed boundary to an injected CoreEngine policy", async () => {
    const engine = new CoreEngine({
      policy: { evaluate: async () => { throw new Error("policy unavailable"); } }
    });
    await expect(engine.policy.evaluate(request)).resolves.toMatchObject({ effect: "deny" });
  });

  it("rejects an invalid timeout configuration", () => {
    expect(() => new FailClosedPolicyEngine({
      evaluate: async () => denyDecision
    }, 0)).toThrow(/positive finite number/);
  });

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
        return allow;
      }
    });
    await expect(policy.evaluate(invalidRequest as never)).resolves.toMatchObject({ effect: "deny" });
    expect(evaluatorCalls).toBe(0);
  });

  it("accepts the documented context envelope with opaque attributes", async () => {
    const evaluator = vi.fn(async () => ({
      effect: "allow" as const,
      reason: "context accepted"
    }));
    const policy = new FailClosedPolicyEngine({ evaluate: evaluator });
    const contextualRequest: PolicyRequest = {
      ...request,
      context: { attributes: { tenant: "tenant-a", clearance: 3 } }
    };

    await expect(policy.evaluate(contextualRequest)).resolves.toEqual({
      effect: "allow",
      reason: "context accepted"
    });
    expect(evaluator).toHaveBeenCalledWith(contextualRequest, expect.objectContaining({
      signal: expect.any(AbortSignal)
    }));
  });
});
