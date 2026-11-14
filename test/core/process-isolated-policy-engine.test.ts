import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { ProcessIsolatedPolicyEngine } from "../../src/core/process-isolated-policy-engine.js";
import type { PolicyRequest } from "../../src/core/contracts.js";

const fixturePath = fileURLToPath(
  new URL("../fixtures/policy-evaluator-fixture.mjs", import.meta.url)
);
const fixtureUrl = pathToFileURL(fixturePath).href;

function request(action = "allow"): PolicyRequest {
  return { actorId: "test-actor", action, resource: "record:123" };
}

function stateObserver(target: string): {
  states: string[];
  reached: Promise<void>;
  onStateChange: (event: { state: string }) => void;
} {
  const states: string[] = [];
  let resolve!: () => void;
  const reached = new Promise<void>((done) => { resolve = done; });
  return {
    states,
    reached,
    onStateChange: (event) => {
      states.push(event.state);
      if (event.state === target) resolve();
    }
  };
}

describe("ProcessIsolatedPolicyEngine", () => {
  it("returns an immutable allow decision only after the child process exits", async () => {
    const engine = new ProcessIsolatedPolicyEngine({ moduleUrl: fixtureUrl });
    const result = await engine.evaluateDetailed(request());
    expect(result).toMatchObject({
      lifecycle: "TERMINAL",
      outcome: "COMPLETED",
      runtimeStatus: "STOPPED",
      cleanupStatus: "COMPLETED",
      decision: { effect: "allow" },
      candidateFrozen: true
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.decision)).toBe(true);
    expect(engine.activeExecutionCount).toBe(0);
  });

  it("preserves an explicit deny decision", async () => {
    const engine = new ProcessIsolatedPolicyEngine({ moduleUrl: fixtureUrl });
    const result = await engine.evaluateDetailed(request("deny"));
    expect(result.outcome).toBe("DENIED");
    expect(result.decision.effect).toBe("deny");
  });

  it("rejects invalid requests without starting a child process", async () => {
    const engine = new ProcessIsolatedPolicyEngine({ moduleUrl: fixtureUrl });
    const result = await engine.evaluateDetailed({
      actorId: " ",
      action: "allow",
      resource: "record:123"
    });
    expect(result.outcome).toBe("DENIED");
    expect(result.runtimeStatus).toBe("NOT_STARTED");
    expect(engine.activeExecutionCount).toBe(0);
  });

  it("fails closed when the evaluator returns an invalid decision", async () => {
    const engine = new ProcessIsolatedPolicyEngine({ moduleUrl: fixtureUrl });
    const result = await engine.evaluateDetailed(request("invalid"));
    expect(result.outcome).toBe("DENIED");
    expect(result.decision.effect).toBe("deny");
  });

  it("does not start work when the caller signal is already aborted", async () => {
    const engine = new ProcessIsolatedPolicyEngine({ moduleUrl: fixtureUrl });
    const controller = new AbortController();
    controller.abort();
    const result = await engine.evaluateDetailed(request(), { signal: controller.signal });
    expect(result.outcome).toBe("CANCELLED");
    expect(result.stopReason).toBe("CALLER_CANCELLED");
    expect(result.runtimeStatus).toBe("NOT_STARTED");
    expect(engine.activeExecutionCount).toBe(0);
  });

  it("cooperatively stops a running evaluator after caller cancellation", async () => {
    const observer = stateObserver("RUNNING");
    const engine = new ProcessIsolatedPolicyEngine({
      moduleUrl: fixtureUrl,
      onStateChange: observer.onStateChange
    });
    const controller = new AbortController();
    const evaluation = engine.evaluateDetailed(request("cooperative"), {
      signal: controller.signal
    });
    await observer.reached;
    controller.abort();
    const result = await evaluation;
    expect(result.outcome).toBe("CANCELLED");
    expect(result.stopReason).toBe("CALLER_CANCELLED");
    expect(result.runtimeStatus).toBe("STOPPED");
    expect(result.cleanupStatus).toBe("COMPLETED");
  });

  it("hard-terminates a non-cooperative evaluator after timeout", async () => {
    const engine = new ProcessIsolatedPolicyEngine({
      moduleUrl: fixtureUrl,
      timeoutMs: 80,
      terminationGraceMs: 20,
      killWaitMs: 1_000
    });
    const result = await engine.evaluateDetailed(request("hang"));
    expect(result.outcome).toBe("TIMED_OUT");
    expect(result.stopReason).toBe("POLICY_TIMEOUT");
    expect(result.runtimeStatus).toBe("STOPPED");
    expect(result.cleanupStatus).toBe("COMPLETED");
    expect(engine.activeExecutionCount).toBe(0);
  });

  it("propagates parent cancellation as a distinct stop reason", async () => {
    const observer = stateObserver("RUNNING");
    const engine = new ProcessIsolatedPolicyEngine({
      moduleUrl: fixtureUrl,
      onStateChange: observer.onStateChange
    });
    const parent = new AbortController();
    const evaluation = engine.evaluateDetailed(request("cooperative"), {
      parentSignal: parent.signal
    });
    await observer.reached;
    parent.abort();
    const result = await evaluation;
    expect(result.outcome).toBe("CANCELLED");
    expect(result.stopReason).toBe("PARENT_CANCELLED");
    expect(result.runtimeStatus).toBe("STOPPED");
  });

  it("rejects an already-expired parent deadline without starting a process", async () => {
    const engine = new ProcessIsolatedPolicyEngine({ moduleUrl: fixtureUrl });
    const result = await engine.evaluateDetailed(request(), { deadlineAt: Date.now() - 1 });
    expect(result.outcome).toBe("TIMED_OUT");
    expect(result.runtimeStatus).toBe("NOT_STARTED");
    expect(engine.activeExecutionCount).toBe(0);
  });

  it.each([
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY]
  ])("rejects a non-finite parent deadline (%s) without starting a process", async (_label, deadlineAt) => {
    const engine = new ProcessIsolatedPolicyEngine({ moduleUrl: fixtureUrl });
    const result = await engine.evaluateDetailed(request(), { deadlineAt });
    expect(result).toMatchObject({
      lifecycle: "TERMINAL",
      outcome: "DENIED",
      runtimeStatus: "NOT_STARTED",
      cleanupStatus: "NOT_REQUIRED",
      decision: {
        effect: "deny",
        reason: "Policy deadline is invalid; access denied."
      }
    });
    expect(engine.activeExecutionCount).toBe(0);
  });

  it("passes the bounded deadline to the child evaluator", async () => {
    const engine = new ProcessIsolatedPolicyEngine({
      moduleUrl: fixtureUrl,
      timeoutMs: 1_000
    });
    const result = await engine.evaluateDetailed(request("deadline"), {
      deadlineAt: Date.now() + 800
    });
    expect(result.outcome).toBe("COMPLETED");
    expect(result.decision.effect).toBe("allow");
  });

  it("does not let late cancellation overwrite a frozen terminal candidate", async () => {
    const controller = new AbortController();
    const observer = stateObserver("FINALIZING");
    const engine = new ProcessIsolatedPolicyEngine({
      moduleUrl: fixtureUrl,
      onStateChange: (event) => {
        observer.onStateChange(event);
        if (event.state === "FINALIZING") controller.abort();
      }
    });
    const result = await engine.evaluateDetailed(request(), { signal: controller.signal });
    expect(result.outcome).toBe("COMPLETED");
    expect(result.decision.effect).toBe("allow");
    expect(result.candidateFrozen).toBe(true);
  });

  it("reports child crashes as failures and never grants access", async () => {
    const engine = new ProcessIsolatedPolicyEngine({ moduleUrl: fixtureUrl });
    const result = await engine.evaluateDetailed(request("crash"));
    expect(result.outcome).toBe("FAILED");
    expect(result.decision.effect).toBe("deny");
    expect(result.runtimeStatus).toBe("STOPPED");
    expect(engine.activeExecutionCount).toBe(0);
  });

  it("enforces the configured concurrent process capacity", async () => {
    const observer = stateObserver("RUNNING");
    const engine = new ProcessIsolatedPolicyEngine({
      moduleUrl: fixtureUrl,
      maxConcurrent: 1,
      timeoutMs: 2_000,
      onStateChange: observer.onStateChange
    });
    const controller = new AbortController();
    const first = engine.evaluateDetailed(request("hang"), { signal: controller.signal });
    await observer.reached;
    const second = await engine.evaluateDetailed(request());
    expect(second.outcome).toBe("FAILED");
    expect(second.decision.effect).toBe("deny");
    controller.abort();
    const firstResult = await first;
    expect(firstResult.outcome).toBe("CANCELLED");
    expect(engine.activeExecutionCount).toBe(0);
  });

  it("shuts down active evaluator processes and rejects new work", async () => {
    const observer = stateObserver("RUNNING");
    const engine = new ProcessIsolatedPolicyEngine({
      moduleUrl: fixtureUrl,
      timeoutMs: 2_000,
      onStateChange: observer.onStateChange
    });
    const first = engine.evaluateDetailed(request("hang"));
    await observer.reached;
    await engine.shutdown();
    const result = await first;
    expect(result.outcome).toBe("CANCELLED");
    expect(result.stopReason).toBe("RUNTIME_SHUTDOWN");
    expect(result.runtimeStatus).toBe("STOPPED");
    const rejected = await engine.evaluateDetailed(request());
    expect(rejected.outcome).toBe("CANCELLED");
    expect(rejected.runtimeStatus).toBe("NOT_STARTED");
  });


  it("applies the configured V8 old-space limit to the child process", async () => {
    const engine = new ProcessIsolatedPolicyEngine({
      moduleUrl: fixtureUrl,
      maxOldSpaceSizeMb: 64
    });
    const result = await engine.evaluateDetailed(request("heap-limit"));
    expect(result.outcome).toBe("COMPLETED");
    expect(result.decision.effect).toBe("allow");
  });

  it("keeps the first stop reason when caller and parent cancellation race", async () => {
    const observer = stateObserver("RUNNING");
    const engine = new ProcessIsolatedPolicyEngine({
      moduleUrl: fixtureUrl,
      onStateChange: observer.onStateChange
    });
    const caller = new AbortController();
    const parent = new AbortController();
    const evaluation = engine.evaluateDetailed(request("hang"), {
      signal: caller.signal,
      parentSignal: parent.signal
    });
    await observer.reached;
    caller.abort();
    parent.abort();
    const result = await evaluation;
    expect(result.outcome).toBe("CANCELLED");
    expect(result.stopReason).toBe("CALLER_CANCELLED");
  });

  it("fails closed when the configured evaluator module cannot be imported", async () => {
    const missingUrl = pathToFileURL(
      fileURLToPath(new URL("../fixtures/missing-policy-module.mjs", import.meta.url))
    ).href;
    const engine = new ProcessIsolatedPolicyEngine({ moduleUrl: missingUrl });
    const result = await engine.evaluateDetailed(request());
    expect(result.outcome).toBe("FAILED");
    expect(result.decision.effect).toBe("deny");
    expect(result.runtimeStatus).toBe("STOPPED");
  });


  it("redacts evaluator-controlled decision reasons", async () => {
    const engine = new ProcessIsolatedPolicyEngine({ moduleUrl: fixtureUrl });
    const result = await engine.evaluateDetailed(request("secret-reason"));
    expect(result.outcome).toBe("COMPLETED");
    expect(result.decision).toEqual({
      effect: "allow",
      reason: "Policy evaluator allowed the operation."
    });
    expect(result.decision.reason).not.toContain("PRIVATE_TOKEN");
  });

  it("redacts exception messages returned over child IPC", async () => {
    const engine = new ProcessIsolatedPolicyEngine({ moduleUrl: fixtureUrl });
    const result = await engine.evaluateDetailed(request("secret-error"));
    expect(result.outcome).toBe("FAILED");
    expect(result.decision.reason).toBe("Policy evaluator process failed; access denied.");
    expect(result.decision.reason).not.toContain("PRIVATE_TOKEN");
  });

  it("does not expose child stderr when the process exits without a result", async () => {
    const engine = new ProcessIsolatedPolicyEngine({ moduleUrl: fixtureUrl });
    const result = await engine.evaluateDetailed(request("secret-stderr"));
    expect(result.outcome).toBe("FAILED");
    expect(result.decision.reason).toBe(
      "Policy evaluator process exited without a valid result; access denied."
    );
    expect(result.decision.reason).not.toContain("PRIVATE_TOKEN");
  });

});
