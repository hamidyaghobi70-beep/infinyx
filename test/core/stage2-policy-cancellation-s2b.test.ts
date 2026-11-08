import { afterEach, describe, expect, it, vi } from "vitest";
import { FailClosedPolicyEngine } from "../../src/core/fail-closed-policy-engine.js";
import type { PolicyEngine, PolicyRequest } from "../../src/core/contracts.js";

const request: PolicyRequest = {
  actorId: "stage2-test",
  action: "policy.evaluate",
  resource: "stage2:policy-signal"
};

afterEach(() => {
  vi.useRealTimers();
});

describe("Stage 2 S2-B — policy cancellation signal observations", () => {
  it("TQ-B-1: records behavior when the caller signal is already aborted", async () => {
    const caller = new AbortController();
    caller.abort(new Error("caller cancelled"));
    let evaluatorCalls = 0;

    const policy: PolicyEngine = new FailClosedPolicyEngine({
      evaluate: async () => {
        evaluatorCalls += 1;
        return { effect: "allow", reason: "delegate completed" };
      }
    });

    const decision = await policy.evaluate(request, { signal: caller.signal });
    expect(evaluatorCalls).toBe(1);
    expect(decision).toEqual({ effect: "allow", reason: "delegate completed" });
  });

  it("TQ-B-2: observes whether caller abort propagates to the evaluator signal", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    let evaluatorSignal: AbortSignal | undefined;

    const policy: PolicyEngine = new FailClosedPolicyEngine({
      evaluate: (_input, options) => {
        evaluatorSignal = options!.signal;
        return new Promise<never>(() => undefined);
      }
    }, 10);

    const result = policy.evaluate(request, { signal: caller.signal });
    await Promise.resolve();
    caller.abort(new Error("caller cancelled"));
    expect(evaluatorSignal).toBeDefined();
    expect(evaluatorSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(10);
    await expect(result).resolves.toMatchObject({ effect: "deny" });
    expect(evaluatorSignal?.aborted).toBe(true);
  });

  it("TQ-B-3: records that the evaluator receives an AbortSignal", async () => {
    let receivedSignal: AbortSignal | undefined;
    const policy = new FailClosedPolicyEngine({
      evaluate: async (_input, options) => {
        receivedSignal = options!.signal;
        return { effect: "allow", reason: "observed signal" };
      }
    });

    await expect(policy.evaluate(request)).resolves.toMatchObject({ effect: "allow" });
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
  });

  it("TQ-B-4: observes an abort event on the evaluator signal at the internal deadline", async () => {
    vi.useFakeTimers();
    let abortEvents = 0;
    let started!: () => void;
    const evaluatorStarted = new Promise<void>((resolve) => { started = resolve; });

    const policy = new FailClosedPolicyEngine({
      evaluate: (_input, options) => new Promise<never>(() => {
        options!.signal.addEventListener("abort", () => { abortEvents += 1; }, { once: true });
        started();
      })
    }, 10);

    const result = policy.evaluate(request);
    await evaluatorStarted;
    await vi.advanceTimersByTimeAsync(10);
    await expect(result).resolves.toMatchObject({ effect: "deny" });
    expect(abortEvents).toBe(1);
  });

  it("TQ-B-5: observes continued evaluator work when the evaluator ignores abort", async () => {
    vi.useFakeTimers();
    let ticks = 0;
    let interval: ReturnType<typeof setInterval> | undefined;
    let started!: () => void;
    const evaluatorStarted = new Promise<void>((resolve) => { started = resolve; });

    const policy = new FailClosedPolicyEngine({
      evaluate: () => new Promise<never>(() => {
        interval = setInterval(() => { ticks += 1; }, 1);
        started();
      })
    }, 10);

    const result = policy.evaluate(request);
    await evaluatorStarted;
    await vi.advanceTimersByTimeAsync(10);
    await expect(result).resolves.toMatchObject({ effect: "deny" });
    const ticksAtTimeout = ticks;

    await vi.advanceTimersByTimeAsync(5);
    expect(ticks).toBeGreaterThan(ticksAtTimeout);
    if (interval !== undefined) clearInterval(interval);
  });
});
