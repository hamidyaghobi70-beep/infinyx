import { ChildProcess } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
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

  it("emits AUTHORIZED only after close-time terminal commitment", async () => {
    const observer = stateObserver("TERMINAL");
    const engine = new ProcessIsolatedPolicyEngine({
      moduleUrl: fixtureUrl,
      onStateChange: observer.onStateChange
    });
    const result = await engine.evaluateDetailed(request());
    expect(result.outcome).toBe("COMPLETED");
    expect(observer.states.indexOf("FINALIZING")).toBeLessThan(
      observer.states.indexOf("AUTHORIZED")
    );
    expect(observer.states.indexOf("AUTHORIZED")).toBeLessThan(
      observer.states.indexOf("TERMINAL")
    );
  });

  it("never emits AUTHORIZED for an explicit deny candidate", async () => {
    const observer = stateObserver("TERMINAL");
    const engine = new ProcessIsolatedPolicyEngine({
      moduleUrl: fixtureUrl,
      onStateChange: observer.onStateChange
    });
    const result = await engine.evaluateDetailed(request("deny"));
    expect(result.outcome).toBe("DENIED");
    expect(observer.states).not.toContain("AUTHORIZED");
  });

  it("accepts output exactly at the per-stream byte boundary across chunks", async () => {
    const engine = new ProcessIsolatedPolicyEngine({
      moduleUrl: fixtureUrl,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
      maxTotalOutputBytes: 2048
    });
    const result = await engine.evaluateDetailed(request("stdout-boundary"));
    expect(result.outcome).toBe("COMPLETED");
    expect(result.decision.effect).toBe("allow");
    expect(engine.activeExecutionCount).toBe(0);
  });

  it("accepts stderr output exactly at its per-stream byte boundary", async () => {
    const engine = new ProcessIsolatedPolicyEngine({
      moduleUrl: fixtureUrl,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
      maxTotalOutputBytes: 2048
    });
    const result = await engine.evaluateDetailed(request("stderr-boundary"));
    expect(result.outcome).toBe("COMPLETED");
    expect(result.decision.effect).toBe("allow");
    expect(engine.activeExecutionCount).toBe(0);
  });

  it("fails closed when stdout and stderr cross their limits concurrently", async () => {
    const engine = new ProcessIsolatedPolicyEngine({
      moduleUrl: fixtureUrl,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
      maxTotalOutputBytes: 2048
    });
    const result = await engine.evaluateDetailed(request("simultaneous-flood"));
    expect(result.outcome).toBe("FAILED");
    expect(result.decision.effect).toBe("deny");
    expect(result.stopReason).toBe("OUTPUT_LIMIT_EXCEEDED");
    expect(engine.activeExecutionCount).toBe(0);
  });

  it("fails closed when stdout exceeds its byte budget", async () => {
    const engine = new ProcessIsolatedPolicyEngine({
      moduleUrl: fixtureUrl,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
      maxTotalOutputBytes: 2048
    });
    const result = await engine.evaluateDetailed(request("stdout-flood"));
    expect(result.outcome).toBe("FAILED");
    expect(result.decision).toEqual({
      effect: "deny",
      reason: "Policy evaluator exceeded its output budget; access denied."
    });
    expect(result.stopReason).toBe("OUTPUT_LIMIT_EXCEEDED");
    expect(result.runtimeStatus).toBe("STOPPED");
    expect(engine.activeExecutionCount).toBe(0);
  });

  it("fails closed when stderr exceeds its byte budget", async () => {
    const engine = new ProcessIsolatedPolicyEngine({
      moduleUrl: fixtureUrl,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
      maxTotalOutputBytes: 2048
    });
    const result = await engine.evaluateDetailed(request("stderr-flood"));
    expect(result.outcome).toBe("FAILED");
    expect(result.stopReason).toBe("OUTPUT_LIMIT_EXCEEDED");
    expect(result.decision.reason).toBe(
      "Policy evaluator exceeded its output budget; access denied."
    );
    expect(engine.activeExecutionCount).toBe(0);
  });

  it("fails closed when combined stdout and stderr exceed the aggregate budget", async () => {
    const engine = new ProcessIsolatedPolicyEngine({
      moduleUrl: fixtureUrl,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
      maxTotalOutputBytes: 1200
    });
    const result = await engine.evaluateDetailed(request("aggregate-flood"));
    expect(result.outcome).toBe("FAILED");
    expect(result.stopReason).toBe("OUTPUT_LIMIT_EXCEEDED");
    expect(result.decision.effect).toBe("deny");
    expect(engine.activeExecutionCount).toBe(0);
  });

  it("does not commit or announce allow when output exceeds budget before close", async () => {
    const observer = stateObserver("TERMINAL");
    const engine = new ProcessIsolatedPolicyEngine({
      moduleUrl: fixtureUrl,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
      maxTotalOutputBytes: 2048,
      onStateChange: observer.onStateChange
    });
    const result = await engine.evaluateDetailed(request("late-stdout-flood"));
    expect(observer.states).not.toContain("AUTHORIZED");
    expect(result.outcome).toBe("FAILED");
    expect(result.stopReason).toBe("OUTPUT_LIMIT_EXCEEDED");
    expect(result.decision).toEqual({
      effect: "deny",
      reason: "Policy evaluator exceeded its output budget; access denied."
    });
    expect(engine.activeExecutionCount).toBe(0);
  });


  it("preserves output failure as primary when it precedes caller cancellation", async () => {
    const controller = new AbortController();
    const states: string[] = [];
    const engine = new ProcessIsolatedPolicyEngine({
      moduleUrl: fixtureUrl,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
      maxTotalOutputBytes: 2048,
      onStateChange: (event) => {
        states.push(event.state);
        // STOP_REQUESTED from the output observer is the deterministic barrier.
        if (event.state === "STOP_REQUESTED") controller.abort();
      }
    });

    const result = await engine.evaluateDetailed(request("stdout-flood"), {
      signal: controller.signal
    });

    expect(result.outcome).toBe("FAILED");
    expect(result.stopReason).toBe("OUTPUT_LIMIT_EXCEEDED");
    expect(result.decision).toEqual({
      effect: "deny",
      reason: "Policy evaluator exceeded its output budget; access denied."
    });
    expect(states).not.toContain("AUTHORIZED");
    expect(engine.activeExecutionCount).toBe(0);
  });

  it("preserves caller cancellation as primary when it precedes output failure", async () => {
    const controller = new AbortController();
    const states: string[] = [];
    const engine = new ProcessIsolatedPolicyEngine({
      moduleUrl: fixtureUrl,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
      maxTotalOutputBytes: 2048,
      onStateChange: (event) => {
        states.push(event.state);
        // FINALIZING is emitted before the parent acknowledges the result;
        // the fixture emits its late output only after that acknowledgement.
        if (event.state === "FINALIZING") controller.abort();
      }
    });

    const result = await engine.evaluateDetailed(request("late-stdout-flood"), {
      signal: controller.signal
    });

    expect(result.outcome).toBe("CANCELLED");
    expect(result.stopReason).toBe("CALLER_CANCELLED");
    expect(result.decision).toEqual({
      effect: "deny",
      reason: "Policy execution cancelled by caller."
    });
    expect(states).not.toContain("AUTHORIZED");
    expect(engine.activeExecutionCount).toBe(0);
  });

  it("retains runtime shutdown as secondary provenance after policy timeout", async () => {
    let shutdownPromise: Promise<void> | undefined;
    const engine = new ProcessIsolatedPolicyEngine({
      moduleUrl: fixtureUrl,
      timeoutMs: 80,
      terminationGraceMs: 10,
      killWaitMs: 500,
      onStateChange: (event) => {
        if (event.state === "STOP_REQUESTED" && shutdownPromise === undefined) {
          // The timeout's STOP_REQUESTED notification is the deterministic
          // barrier; shutdown is initiated in the same coordinator turn.
          shutdownPromise = engine.shutdown();
        }
      }
    });

    const result = await engine.evaluateDetailed(request("hang"));
    await shutdownPromise;

    expect(result.outcome).toBe("TIMED_OUT");
    expect(result.stopReason).toBe("POLICY_TIMEOUT");
    expect(result.stopProvenance).toEqual([
      { code: "POLICY_TIMEOUT", message: "Policy execution timed out." },
      { code: "RUNTIME_SHUTDOWN", message: "Runtime shutdown cancelled policy execution." }
    ]);
    expect(Object.isFrozen(result.stopProvenance)).toBe(true);
    expect(result.stopProvenance?.every((cause) => Object.isFrozen(cause))).toBe(true);
    expect(engine.activeExecutionCount).toBe(0);
  });

  it("retains runtime shutdown provenance when the caller signal is already aborted", async () => {
    const controller = new AbortController();
    let shutdownPromise: Promise<void> | undefined;
    const engine = new ProcessIsolatedPolicyEngine({
      moduleUrl: fixtureUrl,
      terminationGraceMs: 10,
      killWaitMs: 500,
      onStateChange: (event) => {
        if (event.state === "STOP_REQUESTED" && shutdownPromise === undefined) {
          shutdownPromise = engine.shutdown();
        }
      }
    });
    const evaluation = engine.evaluateDetailed(request("hang"), { signal: controller.signal });
    controller.abort();

    const result = await evaluation;
    await shutdownPromise;

    expect(result.outcome).toBe("CANCELLED");
    expect(result.stopReason).toBe("CALLER_CANCELLED");
    expect(result.stopProvenance).toEqual([
      { code: "CALLER_CANCELLED", message: "Policy execution cancelled by caller." },
      { code: "RUNTIME_SHUTDOWN", message: "Runtime shutdown cancelled policy execution." }
    ]);
    expect(engine.activeExecutionCount).toBe(0);
  });

  it("validates aggregate output budget against per-stream budgets", () => {
    expect(() => new ProcessIsolatedPolicyEngine({
      moduleUrl: fixtureUrl,
      maxStdoutBytes: 2048,
      maxStderrBytes: 1024,
      maxTotalOutputBytes: 1024
    })).toThrow(RangeError);
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

  it("fails closed without authorization when the evaluator returns an invalid decision", async () => {
    const observer = stateObserver("TERMINAL");
    const engine = new ProcessIsolatedPolicyEngine({
      moduleUrl: fixtureUrl,
      onStateChange: observer.onStateChange
    });
    const result = await engine.evaluateDetailed(request("invalid"));
    expect(result.outcome).toBe("DENIED");
    expect(result.decision.effect).toBe("deny");
    expect(observer.states).not.toContain("AUTHORIZED");
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

  it("escalates ignored SIGTERM and releases capacity only after child close", async () => {
    const observer = stateObserver("RUNNING");
    const controller = new AbortController();
    const killSignals: Array<NodeJS.Signals | number | undefined> = [];
    const originalKill = ChildProcess.prototype.kill;
    const killSpy = vi.spyOn(ChildProcess.prototype, "kill").mockImplementation(
      function (this: ChildProcess, signal?: NodeJS.Signals | number): boolean {
        killSignals.push(signal);
        return originalKill.call(this, signal);
      }
    );

    try {
      const engine = new ProcessIsolatedPolicyEngine({
        moduleUrl: fixtureUrl,
        timeoutMs: 5_000,
        terminationGraceMs: 10,
        killWaitMs: 80,
        maxConcurrent: 1,
        onStateChange: observer.onStateChange
      });
      const evaluation = engine.evaluateDetailed(request("ignore-sigterm"), {
        signal: controller.signal
      });
      await observer.reached;
      controller.abort();

      const result = await evaluation;
      expect(result.outcome).toBe("CANCELLED");
      expect(result.stopReason).toBe("CALLER_CANCELLED");
      expect(result.runtimeStatus).toBe("STOPPED");
      expect(result.cleanupStatus).toBe("COMPLETED");
      expect(engine.activeExecutionCount).toBe(0);

      // Assert platform-specific termination behavior instead of elapsed wall-clock time.
      const sigtermIndex = killSignals.indexOf("SIGTERM");
      const sigkillIndex = killSignals.indexOf("SIGKILL");
      expect(sigtermIndex).toBeGreaterThanOrEqual(0);
      if (process.platform === "win32") {
        // Node maps supported signals to Windows process termination semantics;
        // the close barrier, not a second signal, confirms the child has ended.
        expect(sigkillIndex).toBe(-1);
      } else {
        expect(sigkillIndex).toBeGreaterThan(sigtermIndex);
      }
    } finally {
      killSpy.mockRestore();
    }
  });

  it("ignores a child error after unresolved commitment and releases its active reference on close", async () => {
    let child: ChildProcess | undefined;
    let resolveUnresolved!: () => void;
    const unresolvedReached = new Promise<void>((resolve) => {
      resolveUnresolved = resolve;
    });
    const observer = stateObserver("RUNNING");
    const killSpy = vi.spyOn(ChildProcess.prototype, "kill").mockImplementation(
      function (this: ChildProcess): boolean {
        child = this;
        return false;
      }
    );

    try {
      const controller = new AbortController();
      const engine = new ProcessIsolatedPolicyEngine({
        moduleUrl: fixtureUrl,
        timeoutMs: 5_000,
        terminationGraceMs: 5,
        killWaitMs: 20,
        onStateChange: (event) => {
          observer.onStateChange(event);
          if (event.state === "UNRESOLVED") resolveUnresolved();
        }
      });
      const evaluation = engine.evaluateDetailed(request("ignore-sigterm"), {
        signal: controller.signal
      });

      await observer.reached;
      controller.abort();
      await unresolvedReached;

      const result = await evaluation;
      expect(result.outcome).toBe("UNRESOLVED");
      expect(result.runtimeStatus).toBe("UNRESOLVED");
      expect(engine.activeExecutionCount).toBe(1);
      expect(child).toBeDefined();

      // Simulate a late ChildProcess error after finishUnresolved committed
      // the immutable record. freezeCandidate must not create a new candidate.
      child!.emit("error", new Error("synthetic late child error"));
      expect(result.outcome).toBe("UNRESOLVED");
      expect(result.decision.reason).toBe(
        "Policy process termination could not be confirmed; access denied."
      );

      const closed = new Promise<void>((resolve) => {
        child!.once("close", () => resolve());
      });
      killSpy.mockRestore();
      child!.kill("SIGKILL");
      await closed;
      expect(engine.activeExecutionCount).toBe(0);
    } finally {
      killSpy.mockRestore();
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
  });

  it("retains capacity until the actual child close after unconfirmed termination", async () => {
    let child: ChildProcess | undefined;
    let resolveClose!: () => void;
    const closeObserved = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    const killSpy = vi.spyOn(ChildProcess.prototype, "kill").mockImplementation(
      function (this: ChildProcess): boolean {
        if (!child) {
          child = this;
          child.once("close", () => resolveClose());
        }
        return false;
      }
    );
    try {
      const observer = stateObserver("RUNNING");
      const controller = new AbortController();
      const engine = new ProcessIsolatedPolicyEngine({
        moduleUrl: fixtureUrl,
        timeoutMs: 5_000,
        terminationGraceMs: 10,
        killWaitMs: 80,
        maxConcurrent: 1,
        onStateChange: observer.onStateChange
      });
      const evaluation = engine.evaluateDetailed(request("ignore-sigterm"), {
        signal: controller.signal
      });
      await observer.reached;
      controller.abort();

      const result = await evaluation;
      expect(result.outcome).toBe("UNRESOLVED");
      expect(result.runtimeStatus).toBe("UNRESOLVED");
      expect(result.cleanupStatus).toBe("UNRESOLVED");
      expect(engine.activeExecutionCount).toBe(1);
      expect(child).toBeDefined();
      expect(killSpy).toHaveBeenNthCalledWith(1, "SIGTERM");
      expect(killSpy).toHaveBeenNthCalledWith(2, "SIGKILL");

      // UNRESOLVED must keep the only slot occupied and reject new work.
      const rejected = await engine.evaluateDetailed(request());
      expect(rejected.outcome).toBe("FAILED");
      expect(rejected.runtimeStatus).toBe("NOT_STARTED");
      expect(rejected.decision.reason).toContain("capacity is exhausted");
      expect(engine.activeExecutionCount).toBe(1);

      // The listener was attached before termination was requested. Only the
      // actual ChildProcess close event may release the retained capacity slot.
      await closeObserved;
      expect(engine.activeExecutionCount).toBe(0);
    } finally {
      killSpy.mockRestore();
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
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

  it("lets cancellation veto authorization after candidate freeze but before terminal commitment", async () => {
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
    expect(result.outcome).toBe("CANCELLED");
    expect(result.stopReason).toBe("CALLER_CANCELLED");
    expect(result.decision.effect).toBe("deny");
    expect(observer.states).not.toContain("AUTHORIZED");
    expect(result.candidateFrozen).toBe(true);
  });


  it("lets caller cancellation veto a frozen allow while the child is held open", async () => {
    const observer = stateObserver("FINALIZING");
    const controller = new AbortController();
    const engine = new ProcessIsolatedPolicyEngine({
      moduleUrl: fixtureUrl,
      timeoutMs: 5_000,
      terminationGraceMs: 10,
      killWaitMs: 500,
      onStateChange: observer.onStateChange
    });
    const evaluation = engine.evaluateDetailed(request("allow-with-active-handle"), {
      signal: controller.signal
    });

    // FINALIZING is the barrier: the allow candidate is frozen, while the
    // fixture's active interval prevents natural child close.
    await observer.reached;
    expect(engine.activeExecutionCount).toBe(1);
    controller.abort();

    const result = await evaluation;
    expect(result.outcome).toBe("CANCELLED");
    expect(result.stopReason).toBe("CALLER_CANCELLED");
    expect(result.decision.effect).toBe("deny");
    expect(observer.states).not.toContain("AUTHORIZED");
    expect(engine.activeExecutionCount).toBe(0);
  });

  it("lets parent cancellation veto a frozen allow while the child is held open", async () => {
    const observer = stateObserver("FINALIZING");
    const parent = new AbortController();
    const engine = new ProcessIsolatedPolicyEngine({
      moduleUrl: fixtureUrl,
      timeoutMs: 5_000,
      terminationGraceMs: 10,
      killWaitMs: 500,
      onStateChange: observer.onStateChange
    });
    const evaluation = engine.evaluateDetailed(request("allow-with-active-handle"), {
      parentSignal: parent.signal
    });

    await observer.reached;
    expect(engine.activeExecutionCount).toBe(1);
    parent.abort();

    const result = await evaluation;
    expect(result.outcome).toBe("CANCELLED");
    expect(result.stopReason).toBe("PARENT_CANCELLED");
    expect(result.decision.effect).toBe("deny");
    expect(observer.states).not.toContain("AUTHORIZED");
    expect(engine.activeExecutionCount).toBe(0);
  });

  it("keeps the deadline active after allow candidate freeze until terminal commitment", async () => {
    const observer = stateObserver("FINALIZING");
    const engine = new ProcessIsolatedPolicyEngine({
      moduleUrl: fixtureUrl,
      timeoutMs: 1_500,
      terminationGraceMs: 10,
      killWaitMs: 500,
      onStateChange: observer.onStateChange
    });
    const evaluation = engine.evaluateDetailed(request("allow-with-active-handle"));
    await observer.reached;
    const result = await evaluation;
    expect(result.outcome).toBe("TIMED_OUT");
    expect(result.stopReason).toBe("POLICY_TIMEOUT");
    expect(result.decision.effect).toBe("deny");
    expect(observer.states).not.toContain("AUTHORIZED");
    expect(engine.activeExecutionCount).toBe(0);
  });

  it("reports child crashes as failures and never grants access", async () => {
    const observer = stateObserver("TERMINAL");
    const engine = new ProcessIsolatedPolicyEngine({
      moduleUrl: fixtureUrl,
      onStateChange: observer.onStateChange
    });
    const result = await engine.evaluateDetailed(request("crash"));
    expect(result.outcome).toBe("FAILED");
    expect(result.decision.effect).toBe("deny");
    expect(result.runtimeStatus).toBe("STOPPED");
    expect(observer.states).not.toContain("AUTHORIZED");
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


  it("lets timeout veto a frozen allow when the deadline barrier precedes child close", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const observer = stateObserver("FINALIZING");
      const engine = new ProcessIsolatedPolicyEngine({
        moduleUrl: fixtureUrl,
        timeoutMs: 100,
        terminationGraceMs: 10,
        killWaitMs: 500,
        onStateChange: observer.onStateChange
      });
      const evaluation = engine.evaluateDetailed(request("allow-with-active-handle"));

      // Candidate Freeze is the barrier. Advance the parent deadline only
      // after the allow candidate exists and the child is still held open.
      await observer.reached;
      expect(engine.activeExecutionCount).toBe(1);
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(10);

      const result = await evaluation;
      expect(result.outcome).toBe("TIMED_OUT");
      expect(result.stopReason).toBe("POLICY_TIMEOUT");
      expect(result.decision.effect).toBe("deny");
      expect(observer.states).not.toContain("AUTHORIZED");
      expect(engine.activeExecutionCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores parent cancellation after child close has committed the frozen allow", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const finalizing = stateObserver("FINALIZING");
      const terminal = stateObserver("TERMINAL");
      const states: string[] = [];
      const parent = new AbortController();
      const engine = new ProcessIsolatedPolicyEngine({
        moduleUrl: fixtureUrl,
        timeoutMs: 100,
        onStateChange: (event) => {
          states.push(event.state);
          finalizing.onStateChange(event);
          terminal.onStateChange(event);
        }
      });
      const evaluation = engine.evaluateDetailed(request(), {
        parentSignal: parent.signal
      });

      // TERMINAL is the close-time commitment barrier. Cancellation arrives
      // only after the committed result has been returned.
      await finalizing.reached;
      await terminal.reached;
      const result = await evaluation;
      const committedStates = [...states];
      parent.abort();

      expect(result.outcome).toBe("COMPLETED");
      expect(result.decision.effect).toBe("allow");
      expect(result.stopReason).toBeUndefined();
      expect(result.stopProvenance).toBeUndefined();
      expect(states.filter((state) => state === "AUTHORIZED")).toHaveLength(1);
      expect(states.indexOf("AUTHORIZED")).toBeLessThan(states.indexOf("TERMINAL"));
      expect(states.indexOf("STOP_REQUESTED")).toBe(-1);
      expect(states).toEqual(committedStates);
      expect(engine.activeExecutionCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("commits a frozen allow when the child-close barrier precedes the deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const finalizing = stateObserver("FINALIZING");
      const terminal = stateObserver("TERMINAL");
      const states: string[] = [];
      const engine = new ProcessIsolatedPolicyEngine({
        moduleUrl: fixtureUrl,
        timeoutMs: 100,
        onStateChange: (event) => {
          states.push(event.state);
          finalizing.onStateChange(event);
          terminal.onStateChange(event);
        }
      });
      const evaluation = engine.evaluateDetailed(request());

      // Wait for Candidate Freeze and then the actual close-time commitment
      // before releasing the still-pending deadline timer.
      await finalizing.reached;
      await terminal.reached;
      const result = await evaluation;
      await vi.advanceTimersByTimeAsync(1_000);

      expect(result.outcome).toBe("COMPLETED");
      expect(result.decision.effect).toBe("allow");
      expect(result.stopReason).toBeUndefined();
      expect(result.stopProvenance).toBeUndefined();
      expect(states.filter((state) => state === "AUTHORIZED")).toHaveLength(1);
      expect(states.indexOf("AUTHORIZED")).toBeLessThan(states.indexOf("TERMINAL"));
      expect(states.indexOf("STOP_REQUESTED")).toBe(-1);
      expect(engine.activeExecutionCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

});
