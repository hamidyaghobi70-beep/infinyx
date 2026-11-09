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
    expect(evaluator).toHaveBeenCalledWith(expect.objectContaining({ actorId: contextualRequest.actorId }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });
});


describe("Policy snapshot and cancellation regressions", () => {
  it("passes a detached deeply immutable request snapshot", async () => {
    const original: PolicyRequest = {
      ...request,
      context: { attributes: { nested: { level: 1 } } }
    };
    let received: PolicyRequest | undefined;
    const policy = new FailClosedPolicyEngine({
      evaluate: async (input) => {
        received = input;
        return { effect: "allow", reason: "snapshot accepted" };
      }
    });
    const evaluation = policy.evaluate(original);
    (original.context!.attributes!.nested as { level: number }).level = 99;
    await expect(evaluation).resolves.toMatchObject({ effect: "allow" });
    expect(received?.context?.attributes?.nested).toEqual({ level: 1 });
    expect(Object.isFrozen(received)).toBe(true);
    expect(Object.isFrozen(received?.context)).toBe(true);
    expect(Object.isFrozen(received?.context?.attributes?.nested)).toBe(true);
  });

  it("snapshots an evaluator decision immediately when the evaluator settles", async () => {
    const mutable = { effect: "allow" as const, reason: "approved" };
    const policy = new FailClosedPolicyEngine({ evaluate: async () => mutable });
    const decision = await policy.evaluate(request);
    mutable.effect = "deny";
    mutable.reason = "changed later";
    expect(decision).toEqual({ effect: "allow", reason: "approved" });
    expect(Object.isFrozen(decision)).toBe(true);
  });

  it("aborts the delegate signal at timeout before returning deny", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const policy = new FailClosedPolicyEngine({
      evaluate: (_input, options) => {
        signal = options!.signal;
        return new Promise<never>(() => undefined);
      }
    }, 25);
    const result = policy.evaluate(request);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(25);
    await expect(result).resolves.toMatchObject({
      effect: "deny",
      reason: "Policy evaluation timed out; access denied."
    });
    expect(signal?.aborted).toBe(true);
  });

  it("denies unsupported mutable values instead of passing them through", async () => {
    const evaluator = vi.fn(async () => ({ effect: "allow" as const, reason: "unexpected" }));
    const policy = new FailClosedPolicyEngine({ evaluate: evaluator });
    const invalid = {
      ...request,
      context: { attributes: { map: new Map([["key", "value"]]) } }
    };
    await expect(policy.evaluate(invalid)).resolves.toMatchObject({ effect: "deny" });
    expect(evaluator).not.toHaveBeenCalled();
  });
});


describe("cooperative evaluator cancellation", () => {
  it("stops evaluator work after the AbortSignal is aborted by the deadline", async () => {
    vi.useFakeTimers();
    let workTicks = 0;
    let stoppedByAbort = false;
    let signal: AbortSignal | undefined;
    let evaluatorStarted!: () => void;
    const started = new Promise<void>((resolve) => { evaluatorStarted = resolve; });

    const policy = new FailClosedPolicyEngine({
      evaluate: (_input, options) => {
        signal = options!.signal;
        return new Promise<{ effect: "deny"; reason: string }>((resolve) => {
          const interval = setInterval(() => { workTicks += 1; }, 1);
          evaluatorStarted();
          signal!.addEventListener("abort", () => {
            stoppedByAbort = true;
            clearInterval(interval);
            resolve({ effect: "deny", reason: "Evaluator cooperatively stopped." });
          }, { once: true });
        });
      }
    }, 25);

    const decision = policy.evaluate(request);
    await started;
    await vi.advanceTimersByTimeAsync(25);
    await expect(decision).resolves.toEqual({
      effect: "deny",
      reason: "Policy evaluation timed out; access denied."
    });

    expect(signal?.aborted).toBe(true);
    expect(stoppedByAbort).toBe(true);
    const ticksAtSettlement = workTicks;
    await vi.advanceTimersByTimeAsync(100);
    expect(workTicks).toBe(ticksAtSettlement);
  });
});


describe("FailClosedPolicyEngine caller and parent cancellation", () => {
  it("does not invoke the evaluator when caller cancellation precedes evaluation", async () => {
    const controller = new AbortController();
    controller.abort();
    const evaluator = vi.fn(async () => ({
      effect: "allow" as const,
      reason: "must not execute"
    }));
    const policy = new FailClosedPolicyEngine({ evaluate: evaluator });
    await expect(policy.evaluate(request, { signal: controller.signal }))
      .resolves.toMatchObject({ effect: "deny" });
    expect(evaluator).not.toHaveBeenCalled();
  });

  it("propagates caller cancellation to a cooperative evaluator", async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    let evaluatorStarted!: () => void;
    const started = new Promise<void>((resolve) => { evaluatorStarted = resolve; });
    const policy = new FailClosedPolicyEngine({
      evaluate: (_input, options) => new Promise((resolve) => {
        observedSignal = options?.signal;
        evaluatorStarted();
        observedSignal?.addEventListener("abort", () => {
          resolve({ effect: "deny", reason: "cooperatively stopped" });
        }, { once: true });
      })
    });

    const decision = policy.evaluate(request, { signal: controller.signal });
    await started;
    controller.abort();
    await expect(decision).resolves.toMatchObject({ effect: "deny" });
    expect(observedSignal?.aborted).toBe(true);
  });

  it("does not allow cancellation after a settled result to rewrite that result", async () => {
    const controller = new AbortController();
    const policy = new FailClosedPolicyEngine({
      evaluate: async () => ({ effect: "allow", reason: "completed first" })
    });
    const result = await policy.evaluate(request, { signal: controller.signal });
    controller.abort();
    expect(result).toEqual({ effect: "allow", reason: "completed first" });
  });

  it("denies an expired parent deadline without invoking the evaluator", async () => {
    const evaluator = vi.fn(async () => ({
      effect: "allow" as const,
      reason: "must not execute"
    }));
    const policy = new FailClosedPolicyEngine({ evaluate: evaluator });
    await expect(policy.evaluate(request, { deadlineAt: Date.now() - 1 }))
      .resolves.toMatchObject({ effect: "deny" });
    expect(evaluator).not.toHaveBeenCalled();
  });

  it("distinguishes parent cancellation from caller cancellation", async () => {
    const parent = new AbortController();
    const policy = new FailClosedPolicyEngine({
      evaluate: (_input, options) => new Promise((resolve) => {
        options?.signal?.addEventListener("abort", () => {
          resolve({ effect: "deny", reason: "stopped" });
        }, { once: true });
      })
    });
    const decision = policy.evaluate(request, { parentSignal: parent.signal });
    parent.abort();
    await expect(decision).resolves.toMatchObject({
      effect: "deny",
      reason: "Parent operation cancelled policy evaluation; access denied."
    });
  });


  it("blocks new evaluations and cancels active work during policy runtime shutdown", async () => {
    let evaluatorStarted!: () => void;
    const started = new Promise<void>((resolve) => { evaluatorStarted = resolve; });
    let observedSignal: AbortSignal | undefined;
    const delegate = {
      evaluate: (_input: typeof request, options?: { signal?: AbortSignal }) =>
        new Promise<{ effect: "deny"; reason: string }>((resolve) => {
          observedSignal = options?.signal;
          evaluatorStarted();
          observedSignal?.addEventListener("abort", () => {
            resolve({ effect: "deny", reason: "stopped" });
          }, { once: true });
        }),
      shutdown: async () => undefined
    };
    const policy = new FailClosedPolicyEngine(delegate);
    const inFlight = policy.evaluate(request);
    await started;
    await policy.shutdown();
    await expect(inFlight).resolves.toMatchObject({ effect: "deny" });
    expect(observedSignal?.aborted).toBe(true);
    await expect(policy.evaluate(request)).resolves.toMatchObject({
      effect: "deny",
      reason: "Policy runtime is shutting down; access denied."
    });
  });

});
