import { afterEach, describe, expect, it, vi } from "vitest";
import { FailClosedPolicyEngine } from "../../src/core/fail-closed-policy-engine.js";
import type { PolicyRequest } from "../../src/core/contracts.js";

const request: PolicyRequest = {
  actorId: "stage2-test",
  action: "policy.evaluate",
  resource: "stage2:policy-cancellation"
};

afterEach(() => {
  vi.useRealTimers();
});

describe("Stage 2 S2-A — non-cooperative evaluator observations", () => {
  it("T-A-1: observes evaluator work continuing after the timeout response", async () => {
    vi.useFakeTimers();
    let ticks = 0;
    let interval: ReturnType<typeof setInterval> | undefined;
    const policy = new FailClosedPolicyEngine({
      evaluate: () => new Promise<never>(() => {
        interval = setInterval(() => { ticks += 1; }, 1);
      })
    }, 10);

    const result = policy.evaluate(request);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);
    await expect(result).resolves.toMatchObject({ effect: "deny" });

    const ticksAtResponse = ticks;
    await vi.advanceTimersByTimeAsync(5);
    expect(ticks).toBeGreaterThan(ticksAtResponse);
    if (interval !== undefined) clearInterval(interval);
  });

  it("T-A-2: a late allow result cannot replace the timeout deny decision", async () => {
    vi.useFakeTimers();
    let resolveLate!: (value: { effect: "allow"; reason: string }) => void;
    const policy = new FailClosedPolicyEngine({
      evaluate: () => new Promise((resolve) => { resolveLate = resolve; })
    }, 10);

    const result = policy.evaluate(request);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);
    await expect(result).resolves.toMatchObject({ effect: "deny" });

    resolveLate({ effect: "allow", reason: "late allow" });
    await Promise.resolve();
    await Promise.resolve();
  });

  it("T-A-3: observes a late evaluator side effect after the timeout response", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    let sideEffectCount = 0;
    const policy = new FailClosedPolicyEngine({
      evaluate: () => new Promise((resolve) => {
        release = () => {
          sideEffectCount += 1;
          resolve({ effect: "allow", reason: "late completion" });
        };
      })
    }, 10);

    const result = policy.evaluate(request);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);
    await expect(result).resolves.toMatchObject({ effect: "deny" });
    expect(sideEffectCount).toBe(0);

    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(sideEffectCount).toBe(1);
  });

  it("T-A-4: returns deny when the evaluator never settles", async () => {
    vi.useFakeTimers();
    const policy = new FailClosedPolicyEngine({
      evaluate: () => new Promise<never>(() => undefined)
    }, 10);

    const result = policy.evaluate(request);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);
    await expect(result).resolves.toEqual({
      effect: "deny",
      reason: "Policy evaluation timed out; access denied."
    });
  });

  it("T-A-5: observes cooperative work stopping after the abort event", async () => {
    vi.useFakeTimers();
    let ticks = 0;
    let interval: ReturnType<typeof setInterval> | undefined;
    let abortObserved = false;
    let started!: () => void;
    const evaluatorStarted = new Promise<void>((resolve) => { started = resolve; });

    const policy = new FailClosedPolicyEngine({
      evaluate: (_input, options) => new Promise((resolve) => {
        interval = setInterval(() => { ticks += 1; }, 1);
        options!.signal.addEventListener("abort", () => {
          abortObserved = true;
          if (interval !== undefined) clearInterval(interval);
          resolve({ effect: "deny", reason: "cooperatively stopped" });
        }, { once: true });
        started();
      })
    }, 10);

    const result = policy.evaluate(request);
    await evaluatorStarted;
    await vi.advanceTimersByTimeAsync(10);
    await expect(result).resolves.toMatchObject({ effect: "deny" });
    expect(abortObserved).toBe(true);

    const ticksAtAbort = ticks;
    await vi.advanceTimersByTimeAsync(5);
    expect(ticks).toBe(ticksAtAbort);
  });
});
