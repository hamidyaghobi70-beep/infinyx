import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreEngine } from "../../src/core/core-engine.js";
import { FailClosedPolicyEngine } from "../../src/core/fail-closed-policy-engine.js";
import type { PolicyEngine, PolicyRequest } from "../../src/core/contracts.js";

const request: PolicyRequest = {
  actorId: "test-actor",
  action: "record.read",
  resource: "record:123"
};

afterEach(() => {
  vi.useRealTimers();
});

describe("FailClosedPolicyEngine delegate method integrity", () => {
  it("pins evaluator and shutdown methods against later delegate mutation", async () => {
    const originalEvaluate = vi.fn(async () => ({ effect: "allow" as const, reason: "pinned" }));
    const originalShutdown = vi.fn(async () => undefined);
    const delegate: PolicyEngine = { evaluate: originalEvaluate, shutdown: originalShutdown };
    const policy = new FailClosedPolicyEngine(delegate);
    const replacementEvaluate = vi.fn(async () => ({ effect: "deny" as const, reason: "replaced" }));
    const replacementShutdown = vi.fn(async () => { throw new Error("replacement shutdown"); });
    delegate.evaluate = replacementEvaluate;
    delegate.shutdown = replacementShutdown;

    await expect(policy.evaluate(request)).resolves.toEqual({ effect: "allow", reason: "pinned" });
    await expect(policy.shutdown()).resolves.toBeUndefined();
    expect(originalEvaluate).toHaveBeenCalledTimes(1);
    expect(originalShutdown).toHaveBeenCalledTimes(1);
    expect(replacementEvaluate).not.toHaveBeenCalled();
    expect(replacementShutdown).not.toHaveBeenCalled();
  });

  it("rejects accessor-backed delegate methods without invoking getters", () => {
    let getterCalls = 0;
    const delegate = Object.defineProperty({}, "evaluate", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("hostile evaluator getter");
      }
    });

    expect(() => new FailClosedPolicyEngine(delegate as never))
      .toThrow(/stable data methods/i);
    expect(getterCalls).toBe(0);
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


  it("fails closed when a caller abort reason has hostile reflection traps", async () => {
    const reason = new Proxy({}, {
      has() { throw new Error("hostile has trap"); },
      get() { throw new Error("hostile get trap"); },
      getOwnPropertyDescriptor() { throw new Error("hostile descriptor trap"); }
    });
    const controller = new AbortController();
    controller.abort(reason);
    const evaluator = vi.fn(async () => ({
      effect: "allow" as const,
      reason: "must not execute"
    }));
    const policy = new FailClosedPolicyEngine({ evaluate: evaluator });

    await expect(policy.evaluate(request, { signal: controller.signal }))
      .resolves.toMatchObject({ effect: "deny" });
    expect(evaluator).not.toHaveBeenCalled();
  });

  it("handles hostile abort reasons during active cancellation", async () => {
    const reason = new Proxy({}, {
      getOwnPropertyDescriptor() { throw new Error("hostile descriptor trap"); }
    });
    const controller = new AbortController();
    let evaluatorStarted!: () => void;
    const started = new Promise<void>((resolve) => { evaluatorStarted = resolve; });
    const policy = new FailClosedPolicyEngine({
      evaluate: (_request, options) => new Promise((resolve) => {
        evaluatorStarted();
        options?.signal?.addEventListener("abort", () => {
          resolve({ effect: "deny", reason: "cooperatively stopped" });
        }, { once: true });
      })
    });

    const pending = policy.evaluate(request, { signal: controller.signal });
    await started;
    controller.abort(reason);
    await expect(pending).resolves.toMatchObject({ effect: "deny" });
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


describe("untrusted policy decision descriptors", () => {
  it("denies accessor-backed decisions without invoking getters", async () => {
    let getterCalls = 0;
    const output = Object.defineProperties({}, {
      effect: {
        enumerable: true,
        get() {
          getterCalls += 1;
          throw new Error("getter must not execute");
        }
      },
      reason: { enumerable: true, value: "apparently valid" }
    });
    const policy = new FailClosedPolicyEngine({
      evaluate: async () => output as never
    });

    await expect(policy.evaluate(request)).resolves.toMatchObject({ effect: "deny" });
    expect(getterCalls).toBe(0);
  });

  it("snapshots a data-only Proxy without invoking its get trap", async () => {
    let getCalls = 0;
    const output = new Proxy(
      { effect: "allow" as const, reason: "descriptor snapshot" },
      {
        get() {
          getCalls += 1;
          throw new Error("property get trap must not execute");
        }
      }
    );
    const policy = new FailClosedPolicyEngine({
      evaluate: async () => output
    });

    await expect(policy.evaluate(request)).resolves.toEqual({
      effect: "allow",
      reason: "descriptor snapshot"
    });
    expect(getCalls).toBe(0);
  });

  it("denies when a Proxy reflection trap throws", async () => {
    const output = new Proxy(
      { effect: "allow" as const, reason: "must not be trusted" },
      {
        ownKeys() {
          throw new Error("untrusted reflection trap");
        }
      }
    );
    const policy = new FailClosedPolicyEngine({
      evaluate: async () => output
    });

    await expect(policy.evaluate(request)).resolves.toMatchObject({ effect: "deny" });
  });

  it("rejects decision objects with unexpected own properties", async () => {
    const policy = new FailClosedPolicyEngine({
      evaluate: async () => ({
        effect: "allow",
        reason: "unexpected property",
        privilegeEscalation: true
      } as never)
    });

    await expect(policy.evaluate(request)).resolves.toMatchObject({ effect: "deny" });
  });

  it("rejects non-enumerable policy decision fields", async () => {
    const output = {};
    Object.defineProperties(output, {
      effect: { configurable: true, enumerable: false, value: "allow" },
      reason: { configurable: true, enumerable: true, value: "hidden effect" }
    });
    const evaluator = vi.fn(async () => output as never);
    const policy = new FailClosedPolicyEngine({ evaluate: evaluator });

    await expect(policy.evaluate(request)).resolves.toMatchObject({ effect: "deny" });
    expect(evaluator).toHaveBeenCalledTimes(1);
  });

});


describe("policy request snapshot descriptor integrity", () => {
  it("denies requests containing non-enumerable data that structuredClone would omit", async () => {
    const attributes = { visible: "value" };
    Object.defineProperty(attributes, "hidden", {
      configurable: true,
      enumerable: false,
      value: "must not be silently discarded"
    });
    const evaluator = vi.fn(async () => ({
      effect: "allow" as const,
      reason: "must not be reached"
    }));
    const policy = new FailClosedPolicyEngine({ evaluate: evaluator });

    await expect(policy.evaluate({
      ...request,
      context: { attributes }
    })).resolves.toMatchObject({ effect: "deny" });
    expect(evaluator).not.toHaveBeenCalled();
  });
});


describe("hostile policy evaluation options", () => {
  it("denies option Proxy getters without rejecting evaluate", async () => {
    const options = new Proxy({}, {
      get(_target, property) {
        if (property === "signal") throw new Error("hostile options getter");
        return undefined;
      }
    });
    const evaluator = vi.fn(async () => ({
      effect: "allow" as const,
      reason: "must not execute"
    }));
    const policy = new FailClosedPolicyEngine({ evaluate: evaluator });

    await expect(policy.evaluate(request, options as never)).resolves.toMatchObject({
      effect: "deny"
    });
    expect(evaluator).not.toHaveBeenCalled();
  });

  it("denies a signal whose listener registration getter throws", async () => {
    const signal = new Proxy({
      aborted: false,
      removeEventListener: () => undefined
    }, {
      get(target, property, receiver) {
        if (property === "addEventListener") throw new Error("hostile registration getter");
        return Reflect.get(target, property, receiver);
      }
    });
    const evaluator = vi.fn(async () => ({
      effect: "allow" as const,
      reason: "must not execute"
    }));
    const policy = new FailClosedPolicyEngine({ evaluate: evaluator });

    await expect(policy.evaluate(request, { signal: signal as unknown as AbortSignal }))
      .resolves.toMatchObject({ effect: "deny" });
    expect(evaluator).not.toHaveBeenCalled();
  });

  it("keeps a settled policy decision when signal listener cleanup throws", async () => {
    const signal = {
      aborted: false,
      addEventListener: () => undefined,
      removeEventListener: () => { throw new Error("hostile cleanup"); }
    } as unknown as AbortSignal;
    const policy = new FailClosedPolicyEngine({
      evaluate: async () => ({ effect: "allow", reason: "evaluation completed" })
    });

    await expect(policy.evaluate(request, { signal })).resolves.toEqual({
      effect: "allow",
      reason: "evaluation completed"
    });
  });

  it("denies a non-finite deadline before invoking the evaluator", async () => {
    const evaluator = vi.fn(async () => ({
      effect: "allow" as const,
      reason: "must not execute"
    }));
    const policy = new FailClosedPolicyEngine({ evaluate: evaluator });

    await expect(policy.evaluate(request, { deadlineAt: Number.POSITIVE_INFINITY }))
      .resolves.toMatchObject({ effect: "deny" });
    expect(evaluator).not.toHaveBeenCalled();
  });
});


describe("global policy evaluation resource bound", () => {
  it("rejects evaluations beyond the process-wide concurrency limit", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let evaluatorCalls = 0;
    const policy = new FailClosedPolicyEngine({
      evaluate: async () => {
        evaluatorCalls += 1;
        await gate;
        return { effect: "allow", reason: "completed" };
      }
    });

    const active = Array.from({ length: 512 }, () => policy.evaluate(request));
    const overflow = await policy.evaluate(request);

    expect(overflow).toMatchObject({
      effect: "deny",
      reason: expect.stringMatching(/concurrency limit/i)
    });
    expect(evaluatorCalls).toBe(0);

    await Promise.resolve();
    await Promise.resolve();
    expect(evaluatorCalls).toBe(512);
    release();
    const results = await Promise.all(active);
    expect(results.every((result) => result.effect === "allow")).toBe(true);
  });
});
