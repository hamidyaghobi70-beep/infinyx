import { describe, expect, it } from "vitest";
import { CoreEngine } from "../../src/core/core-engine.js";
import type { PolicyDecision } from "../../src/core/contracts.js";

const caller = { actorId: "shutdown-test" };
const allow: PolicyDecision = { effect: "allow", reason: "test grant" };

describe("CoreEngine bounded shutdown integration", () => {
  it("closes operation admission synchronously before asynchronous shutdown work", async () => {
    const engine = new CoreEngine({ shutdownTimeoutMs: 100 });
    const operation = engine.registerProtectedOperation({
      id: "read",
      action: "record.read",
      resource: "record:test",
      validateInput: (value): value is null => value === null,
      handler: () => "ok"
    });
    await engine.initialize();
    await engine.start();

    const shutdown = engine.stop();
    expect(engine.state).toBe("stopping");
    await expect(engine.protectedOperations.execute(operation, caller, null))
      .resolves.toMatchObject({ status: "denied" });
    await shutdown;
    expect(engine.state).toBe("stopped");
  });

  it("does not clean modules after timeout while a protected handler is still running, then retries safely", async () => {
    let releaseHandler!: () => void;
    let handlerStarted!: () => void;
    const started = new Promise<void>((resolve) => { handlerStarted = resolve; });
    const handlerGate = new Promise<void>((resolve) => { releaseHandler = resolve; });
    let cleanupCalls = 0;
    let observedSignal: AbortSignal | undefined;
    const engine = new CoreEngine({
      shutdownTimeoutMs: 20,
      policy: { evaluate: async () => allow }
    });
    const operation = engine.registerProtectedOperation({
      id: "long-task",
      action: "task.run",
      resource: "task:test",
      validateInput: (value): value is null => value === null,
      handler: async (_input, context) => {
        observedSignal = context.signal;
        handlerStarted();
        await handlerGate;
        return "completed";
      }
    });
    engine.register({
      id: "worker",
      version: "1.0.0",
      stop: () => { cleanupCalls += 1; }
    });
    await engine.initialize();
    await engine.start();

    const execution = engine.protectedOperations.execute(operation, caller, null);
    await started;
    await expect(engine.stop()).rejects.toMatchObject({ code: "SHUTDOWN_TIMEOUT" });
    expect(observedSignal?.aborted).toBe(true);
    expect(cleanupCalls).toBe(0);
    expect(engine.state).toBe("failed");

    releaseHandler();
    await execution;
    await engine.stop();

    expect(cleanupCalls).toBe(1);
    expect(engine.state).toBe("stopped");
  });

  it("waits for an ignored policy AbortSignal and does not repeat delegate shutdown on retry", async () => {
    let releaseEvaluation!: (decision: PolicyDecision) => void;
    let evaluationStarted!: () => void;
    const started = new Promise<void>((resolve) => { evaluationStarted = resolve; });
    const evaluationGate = new Promise<PolicyDecision>((resolve) => { releaseEvaluation = resolve; });
    let delegateShutdownCalls = 0;
    let cleanupCalls = 0;
    const engine = new CoreEngine({
      shutdownTimeoutMs: 20,
      policy: {
        evaluate: () => {
          evaluationStarted();
          return evaluationGate;
        },
        shutdown: async () => { delegateShutdownCalls += 1; }
      }
    });
    engine.register({
      id: "worker",
      version: "1.0.0",
      stop: () => { cleanupCalls += 1; }
    });
    await engine.initialize();
    await engine.start();

    const evaluation = engine.policy.evaluate({
      actorId: "shutdown-test",
      action: "record.read",
      resource: "record:test"
    });
    await started;
    await expect(engine.stop()).rejects.toMatchObject({ code: "SHUTDOWN_TIMEOUT" });
    await expect(evaluation).resolves.toMatchObject({ effect: "deny" });
    expect(cleanupCalls).toBe(0);
    expect(delegateShutdownCalls).toBe(1);

    releaseEvaluation(allow);
    await engine.stop();

    expect(cleanupCalls).toBe(1);
    expect(delegateShutdownCalls).toBe(1);
    expect(engine.state).toBe("stopped");
  });
});
