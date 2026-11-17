import { describe, expect, it, vi } from "vitest";
import { CoreEngine } from "../../src/core/core-engine.js";

describe("CoreEngine", () => {
  it("does not report a false drain timeout when settlement preceded the deadline but continuation resumed later", async () => {
    const engine = new CoreEngine({
      protectedOperationShutdown: { drainDeadlineMs: 15 }
    });
    engine.register({
      id: "deadline-boundary-module",
      version: "1.0.0",
      initialize: () => undefined
    });
    await engine.initialize();
    await engine.start();

    const clock = [100, 100, 110, 111, 120];
    const now = vi.spyOn(performance, "now").mockImplementation(() => clock.shift() ?? 110);
    try {
      await expect(engine.stop()).resolves.toBeUndefined();
      expect(engine.state).toBe("stopped");
    } finally {
      now.mockRestore();
    }
  });

  it("initializes and starts modules in dependency order, then stops in reverse", async () => {
    const engine = new CoreEngine();
    const calls: string[] = [];

    engine.register({
      id: "api",
      version: "1.0.0",
      dependencies: ["platform"],
      initialize: () => { calls.push("initialize:api"); },
      start: () => { calls.push("start:api"); },
      stop: () => { calls.push("stop:api"); }
    });
    engine.register({
      id: "platform",
      version: "1.0.0",
      initialize: () => { calls.push("initialize:platform"); },
      start: () => { calls.push("start:platform"); },
      stop: () => { calls.push("stop:platform"); }
    });

    await engine.initialize();
    expect(engine.state).toBe("initialized");
    await engine.start();
    expect(engine.state).toBe("running");
    await engine.stop();

    expect(engine.state).toBe("stopped");
    expect(calls).toEqual([
      "initialize:platform",
      "initialize:api",
      "start:platform",
      "start:api",
      "stop:api",
      "stop:platform"
    ]);
  });

  it("rolls back initialized modules when a module fails to start", async () => {
    const engine = new CoreEngine();
    const stopped: string[] = [];
    engine.register({
      id: "platform",
      version: "1.0.0",
      stop: () => { stopped.push("platform"); }
    });
    engine.register({
      id: "worker",
      version: "1.0.0",
      dependencies: ["platform"],
      start: () => { throw new Error("startup failure"); },
      stop: () => { stopped.push("worker"); }
    });

    await engine.initialize();
    await expect(engine.start()).rejects.toThrow(/startup failed/i);
    expect(engine.state).toBe("failed");
    expect(stopped).toEqual(["worker", "platform"]);
  });

  it("cleans up a module whose initialization fails after partial setup", async () => {
    const engine = new CoreEngine();
    const stopped: string[] = [];
    engine.register({
      id: "platform",
      version: "1.0.0",
      stop: () => { stopped.push("platform"); }
    });
    engine.register({
      id: "broken",
      version: "1.0.0",
      dependencies: ["platform"],
      initialize: () => { throw new Error("partial initialization failure"); },
      stop: () => { stopped.push("broken"); }
    });

    await expect(engine.initialize()).rejects.toThrow(/initialization failed/i);
    expect(stopped).toEqual(["broken", "platform"]);
    expect(engine.getModuleStates().get("broken")).toBe("failed");
  });

  it("does not deadlock when a module cleanup attempts a re-entrant stop", async () => {
    const engine = new CoreEngine();
    engine.register({
      id: "worker",
      version: "1.0.0",
      stop: async () => {
        await expect(engine.stop()).rejects.toThrow(/re-entrant stop/i);
      }
    });

    await engine.initialize();
    await engine.stop();

    expect(engine.state).toBe("stopped");
    expect(engine.getModuleStates().get("worker")).toBe("stopped");
  });

  it("shares the exact stop promise between independent consumers", async () => {
    const engine = new CoreEngine();
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    let cleanupCalls = 0;

    engine.register({
      id: "worker",
      version: "1.0.0",
      stop: async () => {
        cleanupCalls += 1;
        await cleanupGate;
      }
    });

    await engine.initialize();
    const promiseA = engine.stop();
    const promiseB = engine.stop();

    expect(promiseA).toBe(promiseB);
    releaseCleanup();
    await Promise.all([promiseA, promiseB]);

    expect(cleanupCalls).toBe(1);
    expect(engine.state).toBe("stopped");
  });

  it("keeps a timer created inside an active cleanup hook in the re-entrant context", async () => {
    const engine = new CoreEngine();
    let reentrantRejected = false;

    engine.register({
      id: "worker",
      version: "1.0.0",
      stop: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        await expect(engine.stop()).rejects.toThrow(/re-entrant stop/i);
        reentrantRejected = true;
      }
    });

    await engine.initialize();
    await engine.stop();

    expect(reentrantRejected).toBe(true);
    expect(engine.state).toBe("stopped");
  });

  it("allows a timer callback after its cleanup hook settles to join the active shutdown", async () => {
    const engine = new CoreEngine();
    let releaseBlocker!: () => void;
    const blockerGate = new Promise<void>((resolve) => { releaseBlocker = resolve; });
    let detachedStop: Promise<void> | undefined;
    let observedTimer!: () => void;
    const timerObserved = new Promise<void>((resolve) => { observedTimer = resolve; });
    let blockerCalls = 0;
    let timerHookCalls = 0;

    // Cleanup is reverse registration order: timer hook first, blocker second.
    engine.register({
      id: "blocker",
      version: "1.0.0",
      stop: async () => {
        blockerCalls += 1;
        await blockerGate;
      }
    });
    engine.register({
      id: "timer",
      version: "1.0.0",
      stop: () => {
        timerHookCalls += 1;
        setTimeout(() => {
          detachedStop = engine.stop();
          observedTimer();
        }, 0);
      }
    });

    await engine.initialize();
    const shutdown = engine.stop();
    await timerObserved;

    expect(detachedStop).toBe(shutdown);
    releaseBlocker();
    await shutdown;

    expect(timerHookCalls).toBe(1);
    expect(blockerCalls).toBe(1);
    expect(engine.state).toBe("stopped");
  });

  it("retries only failed cleanup hooks after an explicit stop call", async () => {
    const engine = new CoreEngine();
    const calls = { stable: 0, flaky: 0 };
    engine.register({
      id: "stable",
      version: "1.0.0",
      stop: () => { calls.stable += 1; }
    });
    engine.register({
      id: "flaky",
      version: "1.0.0",
      stop: () => {
        calls.flaky += 1;
        if (calls.flaky === 1) throw new Error("temporary cleanup failure");
      }
    });

    await engine.initialize();
    await expect(engine.stop()).rejects.toThrow(/failed to stop/i);
    expect(calls).toEqual({ stable: 1, flaky: 1 });
    expect(engine.getModuleStates().get("stable")).toBe("stopped");
    expect(engine.getModuleStates().get("flaky")).toBe("failed");

    await engine.stop();

    expect(calls).toEqual({ stable: 1, flaky: 2 });
    expect(engine.getModuleStates().get("flaky")).toBe("stopped");
    expect(engine.state).toBe("stopped");
  });

  it("does not clean up modules after a drain timeout and retries after blockers settle", async () => {
    let releasePolicyShutdown!: () => void;
    const policyShutdownGate = new Promise<void>((resolve) => {
      releasePolicyShutdown = resolve;
    });
    let moduleStops = 0;
    const engine = new CoreEngine({
      policy: {
        evaluate: async () => ({ effect: "allow", reason: "test" }),
        shutdown: () => policyShutdownGate
      },
      protectedOperationShutdown: { drainDeadlineMs: 10 }
    });
    engine.register({
      id: "timeout-protected-module",
      version: "1.0.0",
      stop: () => { moduleStops += 1; }
    });
    await engine.initialize();
    await engine.start();

    await expect(engine.stop()).rejects.toMatchObject({
      code: "POLICY_EVALUATION_DRAIN_TIMEOUT"
    });
    expect(engine.state).toBe("stopping");
    expect(moduleStops).toBe(0);

    releasePolicyShutdown();
    await engine.stop();

    expect(moduleStops).toBe(1);
    expect(engine.state).toBe("stopped");
  });

  it("rejects accessor Core Engine options without invoking their getters", () => {
    let getterCalls = 0;
    const options = Object.defineProperty({}, "policy", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("hostile policy getter");
      }
    }) as import("../../src/core/core-engine.js").CoreEngineOptions;

    expect(() => new CoreEngine(options)).toThrow(/stable data properties/i);
    expect(getterCalls).toBe(0);
  });

  it("rejects accessor shutdown configuration without invoking its getter", () => {
    let getterCalls = 0;
    const shutdown = Object.defineProperty({}, "drainDeadlineMs", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 1;
      }
    });

    expect(() => new CoreEngine({
      protectedOperationShutdown: shutdown as { drainDeadlineMs?: number }
    })).toThrow(/shutdown configuration is invalid/i);
    expect(getterCalls).toBe(0);
  });

  it("converts throwing option Proxy traps into a controlled configuration error", () => {
    const options = new Proxy({}, {
      ownKeys() {
        throw new Error("hostile options reflection trap");
      }
    }) as import("../../src/core/core-engine.js").CoreEngineOptions;

    expect(() => new CoreEngine(options)).toThrow(/stable data properties/i);
  });

  it("does not authorize actions without an explicit policy", async () => {
    const engine = new CoreEngine();
    const decision = await engine.policy.evaluate({
      actorId: "system",
      action: "tool.execute",
      resource: "tool:example"
    });

    expect(decision.effect).toBe("deny");
  });

  it("prevents registration after initialization", async () => {
    const engine = new CoreEngine();
    await engine.initialize();

    expect(() => engine.register({ id: "late", version: "1.0.0" }))
      .toThrow(/only be registered before initialization/);
  });
});


describe("multi-level intermediate cleanup failure recovery", () => {
  it("does not rerun a cleaned leaf when its intermediate dependency fails", async () => {
    const engine = new CoreEngine();
    const calls: string[] = [];
    let serviceAttempts = 0;

    engine.register({
      id: "foundation",
      version: "1.0.0",
      stop: () => { calls.push("foundation"); }
    });
    engine.register({
      id: "service",
      version: "1.0.0",
      dependencies: ["foundation"],
      stop: () => {
        serviceAttempts += 1;
        calls.push("service:" + serviceAttempts);
        if (serviceAttempts === 1) throw new Error("temporary service cleanup failure");
      }
    });
    engine.register({
      id: "worker",
      version: "1.0.0",
      dependencies: ["service"],
      stop: () => { calls.push("worker"); }
    });

    await engine.initialize();
    await expect(engine.stop()).rejects.toThrow(/failed to stop/i);

    expect(calls).toEqual(["worker", "service:1"]);
    expect(engine.getModuleStates().get("worker")).toBe("stopped");
    expect(engine.getModuleStates().get("service")).toBe("failed");
    expect(engine.getModuleStates().get("foundation")).toBe("initialized");

    await engine.stop();
    expect(calls).toEqual(["worker", "service:1", "service:2", "foundation"]);
    expect(engine.getModuleStates().get("worker")).toBe("stopped");
    expect(engine.getModuleStates().get("service")).toBe("stopped");
    expect(engine.getModuleStates().get("foundation")).toBe("stopped");
    expect(engine.state).toBe("stopped");
  });
});


describe("multi-level dependency cleanup retry", () => {
  it("preserves dependencies after a leaf cleanup failure and retries in dependent-first order", async () => {
    const engine = new CoreEngine();
    const calls: string[] = [];
    let leafAttempts = 0;

    engine.register({
      id: "foundation",
      version: "1.0.0",
      stop: () => { calls.push("foundation"); }
    });
    engine.register({
      id: "service",
      version: "1.0.0",
      dependencies: ["foundation"],
      stop: () => { calls.push("service"); }
    });
    engine.register({
      id: "worker",
      version: "1.0.0",
      dependencies: ["service"],
      stop: () => {
        leafAttempts += 1;
        calls.push("worker:" + leafAttempts);
        if (leafAttempts === 1) throw new Error("temporary leaf cleanup failure");
      }
    });

    await engine.initialize();
    await expect(engine.stop()).rejects.toThrow(/failed to stop/i);

    // A failed dependent blocks cleanup of every dependency below it.
    expect(calls).toEqual(["worker:1"]);
    expect(engine.getModuleStates().get("foundation")).toBe("initialized");
    expect(engine.getModuleStates().get("service")).toBe("initialized");
    expect(engine.getModuleStates().get("worker")).toBe("failed");

    // Retry starts at the failed leaf, then proceeds toward its dependencies.
    await engine.stop();
    expect(calls).toEqual(["worker:1", "worker:2", "service", "foundation"]);
    expect(engine.getModuleStates().get("worker")).toBe("stopped");
    expect(engine.getModuleStates().get("service")).toBe("stopped");
    expect(engine.getModuleStates().get("foundation")).toBe("stopped");
    expect(engine.state).toBe("stopped");

    // A further stop is idempotent; successful cleanup hooks never rerun.
    await engine.stop();
    expect(calls).toEqual(["worker:1", "worker:2", "service", "foundation"]);
  });
});


describe("fan-out dependency cleanup recovery", () => {
  it("cleans independent dependents but preserves a shared dependency after one dependent fails", async () => {
    const engine = new CoreEngine();
    const calls: string[] = [];
    let alphaAttempts = 0;

    engine.register({
      id: "foundation",
      version: "1.0.0",
      stop: () => { calls.push("foundation"); }
    });
    engine.register({
      id: "alpha",
      version: "1.0.0",
      dependencies: ["foundation"],
      stop: () => {
        alphaAttempts += 1;
        calls.push("alpha:" + alphaAttempts);
        if (alphaAttempts === 1) throw new Error("alpha cleanup failed");
      }
    });
    engine.register({
      id: "beta",
      version: "1.0.0",
      dependencies: ["foundation"],
      stop: () => { calls.push("beta"); }
    });

    await engine.initialize();
    await expect(engine.stop()).rejects.toThrow(/failed to stop/i);

    expect(calls).toEqual(["beta", "alpha:1"]);
    expect(engine.getModuleStates().get("beta")).toBe("stopped");
    expect(engine.getModuleStates().get("alpha")).toBe("failed");
    expect(engine.getModuleStates().get("foundation")).toBe("initialized");

    await engine.stop();
    expect(calls).toEqual(["beta", "alpha:1", "alpha:2", "foundation"]);
    expect(engine.state).toBe("stopped");
  });
});

describe("CoreEngine guarded memory composition", () => {
  it("rejects a raw MemoryPort supplied as a module memory capability", async () => {
    const { InMemoryMemoryStore } = await import("../../src/core/in-memory-memory-store.js");
    const raw = new InMemoryMemoryStore();
    const engine = new CoreEngine({
      memory: (() => raw) as unknown as (moduleId: string) => import("../../src/core/guarded-memory-port.js").GuardedMemoryPort
    });
    engine.register({
      id: "worker",
      version: "1.0.0",
      initialize: () => undefined
    });

    await expect(engine.initialize()).rejects.toMatchObject({
      code: "MODULE_INITIALIZATION_FAILED",
      cause: expect.objectContaining({ code: "INVALID_MEMORY_CAPABILITY" })
    });
  });

  it("creates and reuses a guarded memory capability bound to each module", async () => {
    const { GuardedMemoryPort } = await import("../../src/core/guarded-memory-port.js");
    const { InMemoryMemoryStore } = await import("../../src/core/in-memory-memory-store.js");
    const { DefaultDenyPolicyEngine } = await import("../../src/core/default-policy-engine.js");
    const store = new InMemoryMemoryStore();
    const audit = { publishDecision: async () => true, publishFailure: async () => undefined };
    const issued: string[] = [];
    const engine = new CoreEngine({
      memory: (moduleId) => {
        issued.push(moduleId);
        return new GuardedMemoryPort({
          store,
          policy: new DefaultDenyPolicyEngine(),
          audit,
          scope: { tenantId: "tenant", actorId: "actor", moduleId }
        });
      }
    });
    let first: unknown;
    let second: unknown;
    engine.register({
      id: "alpha",
      version: "1.0.0",
      initialize: (context) => { first = context.memory; }
    });
    engine.register({
      id: "beta",
      version: "1.0.0",
      initialize: (context) => { second = context.memory; }
    });

    await engine.initialize();
    expect(issued).toEqual(["alpha", "beta"]);
    expect(first).toBeInstanceOf(GuardedMemoryPort);
    expect(second).toBeInstanceOf(GuardedMemoryPort);
    expect(first).not.toBe(second);
  });
  it("rejects an explicitly present undefined drain deadline", () => {
    expect(() => new CoreEngine({
      protectedOperationShutdown: { drainDeadlineMs: undefined }
    })).toThrow(expect.objectContaining({
      code: "PROTECTED_OPERATION_SHUTDOWN_CONFIG_INVALID"
    }));
  });

  it("uses a provisional default drain deadline when the setting is omitted", async () => {
    const engine = new CoreEngine();
    await engine.initialize();
    await engine.start();
    await engine.stop();
    expect(engine.state).toBe("stopped");
  });

});

describe("CoreEngine policy shutdown integration", () => {
  it("waits for underlying policy work after cancellation before completing shutdown", async () => {
    let releaseEvaluation!: () => void;
    let signalEvaluationStarted!: () => void;
    const evaluationStarted = new Promise<void>((resolve) => {
      signalEvaluationStarted = resolve;
    });
    let evaluatorSignal: AbortSignal | undefined;
    let handlerCalls = 0;
    const engine = new CoreEngine({
      policy: {
        evaluate: (_request, options) => {
          evaluatorSignal = options?.signal;
          signalEvaluationStarted();
          return new Promise((resolve) => {
            releaseEvaluation = () => resolve({ effect: "allow", reason: "allowed" });
          });
        }
      }
    });
    const operation = engine.registerProtectedOperation({
      id: "shutdown.pending-policy",
      action: "record.write",
      resource: "record:shutdown",
      validateInput: (value: unknown): value is undefined => value === undefined,
      handler: () => {
        handlerCalls += 1;
        return "must-not-run";
      }
    });

    await engine.initialize();
    await engine.start();
    const execution = engine.protectedOperations.execute(
      operation, { actorId: "shutdown-policy-test" }, undefined
    );
    await evaluationStarted;

    let shutdownSettled = false;
    const stopping = engine.stop().then(() => {
      shutdownSettled = true;
    });

    expect(evaluatorSignal?.aborted).toBe(true);
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);
    expect(handlerCalls).toBe(0);

    releaseEvaluation();
    await stopping;
    expect(await execution).toMatchObject({ status: "denied" });
    expect(handlerCalls).toBe(0);
    expect(engine.state).toBe("stopped");
  });

  it("blocks module cleanup until a non-cooperative protected handler actually settles", async () => {
    let releaseHandler!: () => void;
    let signalHandlerStarted!: () => void;
    const handlerStarted = new Promise<void>((resolve) => {
      signalHandlerStarted = resolve;
    });
    const handlerGate = new Promise<string>((resolve) => {
      releaseHandler = () => resolve("completed");
    });
    let moduleStops = 0;
    const engine = new CoreEngine({
      policy: {
        evaluate: async () => ({ effect: "allow", reason: "allowed" })
      },
      protectedOperationShutdown: { drainDeadlineMs: 15 }
    });
    const operation = engine.registerProtectedOperation({
      id: "shutdown.non-cooperative-handler",
      action: "record.write",
      resource: "record:shutdown",
      validateInput: (value: unknown): value is undefined => value === undefined,
      handler: async () => {
        signalHandlerStarted();
        // Deliberately ignore the operation AbortSignal until released.
        return handlerGate;
      }
    });
    engine.register({
      id: "shutdown-dependent-module",
      version: "1.0.0",
      stop: () => { moduleStops += 1; }
    });

    await engine.initialize();
    await engine.start();
    const execution = engine.protectedOperations.execute(
      operation, { actorId: "shutdown-handler-test" }, undefined
    );
    await handlerStarted;

    await expect(engine.stop()).rejects.toMatchObject({
      code: "PROTECTED_OPERATION_DRAIN_TIMEOUT"
    });
    expect(engine.state).toBe("stopping");
    expect(moduleStops).toBe(0);

    releaseHandler();
    await expect(execution).resolves.toMatchObject({
      status: "executed",
      value: "completed"
    });
    await engine.stop();

    expect(moduleStops).toBe(1);
    expect(engine.state).toBe("stopped");
  });

  it("blocks module cleanup until detached protected-operation children settle", async () => {
    let releaseChild!: () => void;
    let signalChildStarted!: () => void;
    const childStarted = new Promise<void>((resolve) => {
      signalChildStarted = resolve;
    });
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    let moduleStops = 0;
    const engine = new CoreEngine({
      policy: {
        evaluate: async () => ({ effect: "allow", reason: "allowed" })
      },
      protectedOperationShutdown: { drainDeadlineMs: 15 }
    });
    const operation = engine.registerProtectedOperation({
      id: "shutdown.detached-child",
      action: "record.write",
      resource: "record:shutdown-child",
      validateInput: (value: unknown): value is undefined => value === undefined,
      handler: (_input, context) => {
        void context.runChild(async () => {
          signalChildStarted();
          await childGate;
        });
        return "root-handler-completed";
      }
    });
    engine.register({
      id: "shutdown-child-dependent-module",
      version: "1.0.0",
      stop: () => { moduleStops += 1; }
    });

    await engine.initialize();
    await engine.start();
    const execution = engine.protectedOperations.execute(
      operation, { actorId: "shutdown-child-test" }, undefined
    );
    await childStarted;

    await expect(engine.stop()).rejects.toMatchObject({
      code: "PROTECTED_OPERATION_DRAIN_TIMEOUT"
    });
    expect(engine.state).toBe("stopping");
    expect(moduleStops).toBe(0);

    releaseChild();
    await expect(execution).resolves.toEqual({
      status: "executed",
      value: "root-handler-completed"
    });
    await engine.stop();

    expect(moduleStops).toBe(1);
    expect(engine.state).toBe("stopped");
  });

  it("retries a transient policy shutdown failure without rerunning successful cleanup", async () => {
    let shutdownCalls = 0;
    let moduleStops = 0;
    const engine = new CoreEngine({
      policy: {
        evaluate: async () => ({ effect: "allow", reason: "allowed" }),
        shutdown: () => {
          shutdownCalls += 1;
          if (shutdownCalls === 1) throw new Error("temporary policy shutdown failure");
        }
      }
    });
    engine.register({
      id: "policy-retry-module",
      version: "1.0.0",
      stop: () => { moduleStops += 1; }
    });

    await engine.initialize();
    await engine.start();
    await expect(engine.stop()).rejects.toMatchObject({
      code: "POLICY_SHUTDOWN_FAILED"
    });
    expect(engine.state).toBe("stopping");
    expect(moduleStops).toBe(0);
    expect(shutdownCalls).toBe(1);

    await engine.stop();
    expect(shutdownCalls).toBe(2);
    expect(moduleStops).toBe(1);
    expect(engine.state).toBe("stopped");
  });

  it("shares one concurrent retry after a transient policy shutdown failure", async () => {
    let shutdownCalls = 0;
    let moduleStops = 0;
    let releaseRetry!: () => void;
    const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve; });
    const engine = new CoreEngine({
      policy: {
        evaluate: async () => ({ effect: "allow", reason: "allowed" }),
        shutdown: () => {
          shutdownCalls += 1;
          if (shutdownCalls === 1) throw new Error("temporary policy shutdown failure");
          return retryGate;
        }
      }
    });
    engine.register({
      id: "policy-concurrent-retry-module",
      version: "1.0.0",
      stop: () => { moduleStops += 1; }
    });

    await engine.initialize();
    await engine.start();
    await expect(engine.stop()).rejects.toMatchObject({ code: "POLICY_SHUTDOWN_FAILED" });

    const retryA = engine.stop();
    const retryB = engine.stop();
    expect(retryB).toBe(retryA);
    expect(shutdownCalls).toBe(2);
    expect(moduleStops).toBe(0);

    releaseRetry();
    await Promise.all([retryA, retryB]);
    expect(shutdownCalls).toBe(2);
    expect(moduleStops).toBe(1);
    expect(engine.state).toBe("stopped");
  });
});

describe("CoreEngine policy shutdown retry alignment", () => {
  it("keeps CoreEngine and policy shutdown retry state aligned across repeated failures", async () => {
    let shutdownCalls = 0;
    let releaseSecond!: (error?: Error) => void;
    const secondAttempt = new Promise<void>((resolve, reject) => {
      releaseSecond = (error) => error ? reject(error) : resolve();
    });
    let moduleStops = 0;
    const engine = new CoreEngine({
      policy: {
        evaluate: async () => ({ effect: "allow", reason: "allowed" }),
        shutdown: () => {
          shutdownCalls += 1;
          if (shutdownCalls === 1) throw new Error("first transient failure");
          if (shutdownCalls === 2) return secondAttempt;
        }
      }
    });
    engine.register({
      id: "policy-layer-alignment-module",
      version: "1.0.0",
      stop: () => { moduleStops += 1; }
    });

    await engine.initialize();
    await engine.start();
    await expect(engine.stop()).rejects.toMatchObject({
      code: "POLICY_SHUTDOWN_FAILED",
      shutdownBlockers: [{
        code: "POLICY_SHUTDOWN_FAILED",
        subsystem: "policy",
        state: "failed"
      }]
    });
    expect(engine.state).toBe("stopping");
    expect(engine.getModuleStates().get("policy-layer-alignment-module")).toBe("initialized");
    await expect(engine.policy.evaluate({
      action: "record.read",
      resource: "record:retry",
      actorId: "retry-test"
    })).resolves.toMatchObject({ effect: "deny" });

    const retry = engine.stop();
    expect(shutdownCalls).toBe(2);
    expect(moduleStops).toBe(0);
    releaseSecond(new Error("second transient failure"));
    await expect(retry).rejects.toMatchObject({
      code: "POLICY_SHUTDOWN_FAILED",
      shutdownBlockers: [{
        code: "POLICY_SHUTDOWN_FAILED",
        subsystem: "policy",
        state: "failed"
      }]
    });
    expect(engine.state).toBe("stopping");
    expect(moduleStops).toBe(0);

    await engine.stop();
    expect(shutdownCalls).toBe(3);
    expect(moduleStops).toBe(1);
    expect(engine.state).toBe("stopped");
  });
});


describe("CoreEngine module memory capability lifetime", () => {
  it("releases a module memory capability after successful cleanup", async () => {
    const { GuardedMemoryPort } = await import("../../src/core/guarded-memory-port.js");
    const { InMemoryMemoryStore } = await import("../../src/core/in-memory-memory-store.js");
    const { DefaultDenyPolicyEngine } = await import("../../src/core/default-policy-engine.js");
    const engine = new CoreEngine({
      memory: (moduleId) => new GuardedMemoryPort({
        store: new InMemoryMemoryStore(),
        policy: new DefaultDenyPolicyEngine(),
        audit: { publishDecision: async () => true, publishFailure: async () => undefined },
        scope: { tenantId: "tenant", actorId: "actor", moduleId }
      })
    });
    engine.register({ id: "memory-worker", version: "1.0.0", initialize: () => undefined });
    await engine.initialize();

    const internals = engine as unknown as { moduleMemory: Map<string, unknown> };
    expect(internals.moduleMemory.size).toBe(1);

    await engine.stop();
    expect(internals.moduleMemory.size).toBe(0);
  });

  it("retains a module memory capability after failed cleanup and releases it on retry", async () => {
    const { GuardedMemoryPort } = await import("../../src/core/guarded-memory-port.js");
    const { InMemoryMemoryStore } = await import("../../src/core/in-memory-memory-store.js");
    const { DefaultDenyPolicyEngine } = await import("../../src/core/default-policy-engine.js");
    let attempts = 0;
    const engine = new CoreEngine({
      memory: (moduleId) => new GuardedMemoryPort({
        store: new InMemoryMemoryStore(),
        policy: new DefaultDenyPolicyEngine(),
        audit: { publishDecision: async () => true, publishFailure: async () => undefined },
        scope: { tenantId: "tenant", actorId: "actor", moduleId }
      })
    });
    engine.register({
      id: "retry-memory-worker",
      version: "1.0.0",
      initialize: () => undefined,
      stop: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary cleanup failure");
      }
    });
    await engine.initialize();

    const internals = engine as unknown as { moduleMemory: Map<string, unknown> };
    expect(internals.moduleMemory.size).toBe(1);
    await expect(engine.stop()).rejects.toThrow(/failed to stop/i);
    expect(internals.moduleMemory.size).toBe(1);

    await engine.stop();
    expect(internals.moduleMemory.size).toBe(0);
    expect(attempts).toBe(2);
  });
});


describe("CoreEngine rejects and revokes mismatched memory capabilities", () => {
  it("revokes a scope-mismatched capability before initialization rollback", async () => {
    const { GuardedMemoryPort } = await import("../../src/core/guarded-memory-port.js");
    const { InMemoryMemoryStore } = await import("../../src/core/in-memory-memory-store.js");
    const { DefaultDenyPolicyEngine } = await import("../../src/core/default-policy-engine.js");
    let capability!: InstanceType<typeof GuardedMemoryPort>;
    const engine = new CoreEngine({
      memory: (moduleId) => {
        capability = new GuardedMemoryPort({
          store: new InMemoryMemoryStore(),
          policy: new DefaultDenyPolicyEngine(),
          audit: { publishDecision: async () => true, publishFailure: async () => undefined },
          scope: { tenantId: "tenant", actorId: "actor", moduleId: moduleId + "-wrong" }
        });
        return capability;
      }
    });
    engine.register({
      id: "mismatched-memory",
      version: "1.0.0",
      initialize: () => undefined
    });

    await expect(engine.initialize()).rejects.toMatchObject({
      code: "MODULE_INITIALIZATION_FAILED"
    });
    await expect(capability.read({ namespace: "n", key: "late" })).rejects.toMatchObject({
      code: "MEMORY_CAPABILITY_REVOKED"
    });
    expect(engine.state).toBe("failed");

    await engine.stop();
    expect(engine.state).toBe("stopped");
  });
});


describe("CoreEngine injected Event Bus capability boundary", () => {
  it("pins injected Event Bus methods and preserves the adapter receiver", async () => {
    const adapter = {
      publishCalls: 0,
      subscribe() {
        return () => undefined;
      },
      async publish() {
        this.publishCalls += 1;
      }
    };
    const engine = new CoreEngine({
      events: adapter as unknown as import("../../src/core/contracts.js").EventBusPort
    });

    adapter.publish = async () => {
      throw new Error("replacement method must not run");
    };
    await engine.events.publish("core.test", {});
    expect(adapter.publishCalls).toBe(1);
    expect(Object.isFrozen(engine.events)).toBe(true);
  });

  it("rejects accessor-backed Event Bus methods without invoking getters", () => {
    let getterCalls = 0;
    const adapter = {
      publish: async () => undefined
    };
    Object.defineProperty(adapter, "subscribe", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("hostile subscribe getter");
      }
    });

    expect(() => new CoreEngine({
      events: adapter as unknown as import("../../src/core/contracts.js").EventBusPort
    })).toThrow(/event bus capability/i);
    expect(getterCalls).toBe(0);
  });

  it("converts hostile Event Bus prototype reflection into a controlled error", () => {
    const adapter = new Proxy({}, {
      getPrototypeOf() {
        throw new Error("hostile Event Bus prototype trap");
      }
    });

    expect(() => new CoreEngine({
      events: adapter as import("../../src/core/contracts.js").EventBusPort
    })).toThrow(/event bus capability/i);
  });

  it("does not expose mutable adapter method references to module contexts", async () => {
    let delivered = 0;
    const adapter = {
      subscribe: () => () => undefined,
      publish: async () => { delivered += 1; }
    };
    const engine = new CoreEngine({
      events: adapter as unknown as import("../../src/core/contracts.js").EventBusPort
    });
    let moduleEvents: import("../../src/core/contracts.js").EventBusPort | undefined;
    engine.register({
      id: "event-capability-consumer",
      version: "1.0.0",
      initialize: (context) => { moduleEvents = context.events; }
    });

    adapter.publish = async () => { throw new Error("mutated adapter"); };
    await engine.initialize();
    await moduleEvents!.publish("module.test", {});
    expect(delivered).toBe(1);
    expect(Object.isFrozen(moduleEvents)).toBe(true);
  });
  it("keeps memory available during module cleanup, then revokes retained references", async () => {
    const { GuardedMemoryPort } = await import("../../src/core/guarded-memory-port.js");
    const { InMemoryMemoryStore } = await import("../../src/core/in-memory-memory-store.js");
    const { DefaultDenyPolicyEngine } = await import("../../src/core/default-policy-engine.js");
    const store = new InMemoryMemoryStore();
    const audit = { publishDecision: async () => true, publishFailure: async () => undefined };
    const engine = new CoreEngine({
      memory: (moduleId) => new GuardedMemoryPort({
        store,
        policy: { evaluate: async () => ({ effect: "allow" as const, reason: "shutdown test allow" }) },
        audit,
        scope: { tenantId: "tenant", actorId: "actor", moduleId }
      })
    });
    let retained: import("../../src/core/contracts.js").MemoryPort | undefined;
    engine.register({
      id: "worker",
      version: "1.0.0",
      initialize: (context) => { retained = context.memory; },
      stop: async (context) => {
        await context.memory?.write({ namespace: "shutdown", key: "final" }, "persisted");
      }
    });

    await engine.initialize();
    await engine.start();
    await engine.stop();

    expect(await store.read({ namespace: "tenant/shutdown", key: "final" })).toBe('"persisted"');
    await expect(retained!.read({ namespace: "shutdown", key: "final" })).rejects.toMatchObject({
      code: "MEMORY_CAPABILITY_REVOKED"
    });
    await expect(retained!.write({ namespace: "shutdown", key: "late" }, "x")).rejects.toMatchObject({
      code: "MEMORY_CAPABILITY_REVOKED"
    });
  });

});


describe("CoreEngine bounded module memory drain", () => {
  it("times out a stuck memory drain, revokes admission, and retries without rerunning a successful stop hook", async () => {
    const { GuardedMemoryPort } = await import("../../src/core/guarded-memory-port.js");
    let releaseRead!: (value: string) => void;
    let signalReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      signalReadStarted = resolve;
    });
    const store: import("../../src/core/contracts.js").MemoryPort = {
      read: () => {
        signalReadStarted();
        return new Promise<string>((resolve) => { releaseRead = resolve; });
      },
      write: async () => undefined,
      delete: async () => undefined
    };
    const memoryByModule = new Map<string, InstanceType<typeof GuardedMemoryPort>>();
    const engine = new CoreEngine({
      protectedOperationShutdown: { drainDeadlineMs: 25 },
      memory: (moduleId) => {
        const memory = new GuardedMemoryPort({
          store,
          policy: { evaluate: async () => ({ effect: "allow" as const, reason: "test allow" }) },
          audit: { publishDecision: async () => true, publishFailure: async () => undefined },
          scope: { tenantId: "tenant", actorId: "actor", moduleId }
        });
        memoryByModule.set(moduleId, memory);
        return memory;
      }
    });
    let stopCalls = 0;
    engine.register({
      id: "memory-drain-worker",
      version: "1.0.0",
      initialize: () => undefined,
      stop: () => { stopCalls += 1; }
    });

    await engine.initialize();
    await engine.start();
    const memory = memoryByModule.get("memory-drain-worker")!;
    const pendingRead = memory.read({ namespace: "shutdown", key: "pending" });
    await readStarted;

    await expect(engine.stop()).rejects.toThrow(/failed to stop/i);
    expect(engine.state).toBe("failed");
    expect(stopCalls).toBe(1);
    await expect(memory.read({ namespace: "shutdown", key: "late" })).rejects.toMatchObject({
      code: "MEMORY_CAPABILITY_REVOKED"
    });

    releaseRead('"settled"');
    await expect(pendingRead).resolves.toBe("settled");

    await engine.stop();
    expect(stopCalls).toBe(1);
    expect(engine.state).toBe("stopped");
  });
});


describe("CoreEngine bounded rollback memory drain", () => {
  it("bounds initialization rollback and resumes after the admitted memory operation settles", async () => {
    const { GuardedMemoryPort } = await import("../../src/core/guarded-memory-port.js");
    let releaseRead!: (value: string) => void;
    let signalReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => { signalReadStarted = resolve; });
    const store: import("../../src/core/contracts.js").MemoryPort = {
      read: () => {
        signalReadStarted();
        return new Promise<string>((resolve) => { releaseRead = resolve; });
      },
      write: async () => undefined,
      delete: async () => undefined
    };
    let memory!: InstanceType<typeof GuardedMemoryPort>;
    let stopCalls = 0;
    const engine = new CoreEngine({
      protectedOperationShutdown: { drainDeadlineMs: 25 },
      memory: (moduleId) => {
        memory = new GuardedMemoryPort({
          store,
          policy: { evaluate: async () => ({ effect: "allow" as const, reason: "rollback test" }) },
          audit: { publishDecision: async () => true, publishFailure: async () => undefined },
          scope: { tenantId: "tenant", actorId: "actor", moduleId }
        });
        return memory;
      }
    });
    engine.register({
      id: "rollback-worker",
      version: "1.0.0",
      initialize: (context) => {
        void context.memory!.read({ namespace: "rollback", key: "pending" });
        throw new Error("initialization failed after starting memory work");
      },
      stop: () => { stopCalls += 1; }
    });

    const initialization = engine.initialize();
    await readStarted;
    await expect(initialization).rejects.toThrow(/rollback failed/i);
    expect(engine.state).toBe("failed");
    expect(stopCalls).toBe(1);
    await expect(memory.read({ namespace: "rollback", key: "late" })).rejects.toMatchObject({
      code: "MEMORY_CAPABILITY_REVOKED"
    });

    releaseRead('"finished"');
    await engine.stop();
    expect(stopCalls).toBe(1);
    expect(engine.state).toBe("stopped");
  });

  it("bounds startup rollback and does not rerun a successful stop hook on recovery", async () => {
    const { GuardedMemoryPort } = await import("../../src/core/guarded-memory-port.js");
    let releaseRead!: (value: string) => void;
    let signalReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => { signalReadStarted = resolve; });
    const store: import("../../src/core/contracts.js").MemoryPort = {
      read: () => {
        signalReadStarted();
        return new Promise<string>((resolve) => { releaseRead = resolve; });
      },
      write: async () => undefined,
      delete: async () => undefined
    };
    let memory!: InstanceType<typeof GuardedMemoryPort>;
    let stopCalls = 0;
    const engine = new CoreEngine({
      protectedOperationShutdown: { drainDeadlineMs: 25 },
      memory: (moduleId) => {
        memory = new GuardedMemoryPort({
          store,
          policy: { evaluate: async () => ({ effect: "allow" as const, reason: "rollback test" }) },
          audit: { publishDecision: async () => true, publishFailure: async () => undefined },
          scope: { tenantId: "tenant", actorId: "actor", moduleId }
        });
        return memory;
      }
    });
    engine.register({
      id: "rollback-worker",
      version: "1.0.0",
      initialize: () => undefined,
      start: (context) => {
        void context.memory!.read({ namespace: "rollback", key: "pending" });
      },
      stop: () => { stopCalls += 1; }
    });
    engine.register({
      id: "rollback-failure",
      version: "1.0.0",
      dependencies: ["rollback-worker"],
      start: () => { throw new Error("later module failed to start"); }
    });

    await engine.initialize();
    const startup = engine.start();
    await readStarted;
    await expect(startup).rejects.toThrow(/rollback failed/i);
    expect(engine.state).toBe("failed");
    expect(stopCalls).toBe(1);
    await expect(memory.read({ namespace: "rollback", key: "late" })).rejects.toMatchObject({
      code: "MEMORY_CAPABILITY_REVOKED"
    });

    releaseRead('"finished"');
    await engine.stop();
    expect(stopCalls).toBe(1);
    expect(engine.state).toBe("stopped");
  });
});


describe("CoreEngine rollback and shutdown concurrency", () => {
  it("joins an in-flight initialization rollback and finalizes the engine as stopped", async () => {
    const engine = new CoreEngine({
      protectedOperationShutdown: { drainDeadlineMs: 1000 }
    });
    let releaseStop!: () => void;
    let signalStopStarted!: () => void;
    const stopStarted = new Promise<void>((resolve) => { signalStopStarted = resolve; });
    const stopGate = new Promise<void>((resolve) => { releaseStop = resolve; });
    let stopCalls = 0;

    engine.register({
      id: "initialization-worker",
      version: "1.0.0",
      initialize: () => { throw new Error("initialization failed"); },
      stop: async () => {
        stopCalls += 1;
        signalStopStarted();
        await stopGate;
      }
    });

    const initialization = engine.initialize();
    await stopStarted;

    expect(engine.state).toBe("failed");
    const shutdown = engine.stop();
    expect(stopCalls).toBe(1);

    releaseStop();
    await expect(initialization).rejects.toMatchObject({ code: "MODULE_INITIALIZATION_FAILED" });
    await shutdown;

    expect(stopCalls).toBe(1);
    expect(engine.getModuleStates().get("initialization-worker")).toBe("stopped");
    expect(engine.state).toBe("stopped");
  });

  it("shares a failed rollback cleanup with shutdown and permits a clean retry", async () => {
    const engine = new CoreEngine({
      protectedOperationShutdown: { drainDeadlineMs: 1000 }
    });
    let releaseFirstStop!: () => void;
    let signalFirstStopStarted!: () => void;
    const firstStopStarted = new Promise<void>((resolve) => { signalFirstStopStarted = resolve; });
    const firstStopGate = new Promise<void>((_resolve, reject) => {
      releaseFirstStop = () => reject(new Error("first cleanup attempt failed"));
    });
    let stopCalls = 0;

    engine.register({
      id: "worker",
      version: "1.0.0",
      start: () => { throw new Error("startup failed"); },
      stop: async () => {
        stopCalls += 1;
        if (stopCalls === 1) {
          signalFirstStopStarted();
          await firstStopGate;
        }
      }
    });

    await engine.initialize();
    const startup = engine.start();
    await firstStopStarted;

    const shutdown = engine.stop();
    expect(stopCalls).toBe(1);

    releaseFirstStop();
    await expect(startup).rejects.toThrow("Startup and rollback failed");
    await expect(shutdown).rejects.toMatchObject({ code: "MODULE_STOP_FAILED" });

    expect(stopCalls).toBe(1);
    expect(engine.getModuleStates().get("worker")).toBe("failed");

    await engine.stop();

    expect(stopCalls).toBe(2);
    expect(engine.getModuleStates().get("worker")).toBe("stopped");
    expect(engine.state).toBe("stopped");
  });

  it("joins an in-flight startup rollback without invoking module cleanup twice", async () => {
    const engine = new CoreEngine({
      protectedOperationShutdown: { drainDeadlineMs: 1000 }
    });
    let releaseStop!: () => void;
    let signalStopStarted!: () => void;
    const stopStarted = new Promise<void>((resolve) => { signalStopStarted = resolve; });
    const stopGate = new Promise<void>((resolve) => { releaseStop = resolve; });
    let stopCalls = 0;

    engine.register({
      id: "worker",
      version: "1.0.0",
      start: () => { throw new Error("startup failed"); },
      stop: async () => {
        stopCalls += 1;
        signalStopStarted();
        await stopGate;
      }
    });

    await engine.initialize();
    const startup = engine.start();
    await stopStarted;

    expect(engine.state).toBe("failed");
    const shutdown = engine.stop();
    expect(stopCalls).toBe(1);

    releaseStop();
    await expect(startup).rejects.toThrow(/startup failed/i);
    await shutdown;

    expect(stopCalls).toBe(1);
    expect(engine.state).toBe("stopped");
    expect(engine.getModuleStates().get("worker")).toBe("stopped");
  });
});

describe("CoreEngine bounded module stop hooks", () => {
  it("times out a pending dependent stop hook and resumes without invoking it twice", async () => {
    const engine = new CoreEngine({
      protectedOperationShutdown: { drainDeadlineMs: 25 }
    });
    let releaseDependent!: () => void;
    let signalDependentStarted!: () => void;
    const dependentStarted = new Promise<void>((resolve) => { signalDependentStarted = resolve; });
    const calls: string[] = [];
    engine.register({
      id: "foundation",
      version: "1.0.0",
      stop: () => { calls.push("foundation"); }
    });
    engine.register({
      id: "dependent",
      version: "1.0.0",
      dependencies: ["foundation"],
      stop: () => {
        calls.push("dependent");
        signalDependentStarted();
        return new Promise<void>((resolve) => { releaseDependent = resolve; });
      }
    });

    await engine.initialize();
    await engine.start();
    const stopping = engine.stop();
    await dependentStarted;
    await expect(stopping).rejects.toThrow(/failed to stop/i);

    expect(engine.state).toBe("failed");
    expect(calls).toEqual(["dependent"]);
    expect(engine.getModuleStates().get("foundation")).toBe("initialized");

    releaseDependent();
    await engine.stop();

    expect(calls).toEqual(["dependent", "foundation"]);
    expect(engine.getModuleStates().get("dependent")).toBe("stopped");
    expect(engine.getModuleStates().get("foundation")).toBe("stopped");
    expect(engine.state).toBe("stopped");
  });
});

describe("CoreEngine concurrent stop single-flight", () => {
  it("returns the same shutdown promise and invokes each module stop hook once", async () => {
    const engine = new CoreEngine({
      protectedOperationShutdown: { drainDeadlineMs: 1000 }
    });
    let releaseStop!: () => void;
    let signalStopStarted!: () => void;
    const stopStarted = new Promise<void>((resolve) => { signalStopStarted = resolve; });
    const stopGate = new Promise<void>((resolve) => { releaseStop = resolve; });
    let stopCalls = 0;

    engine.register({
      id: "single-flight-worker",
      version: "1.0.0",
      stop: async () => {
        stopCalls += 1;
        signalStopStarted();
        await stopGate;
      }
    });

    await engine.initialize();
    await engine.start();

    const firstStop = engine.stop();
    const secondStop = engine.stop();
    expect(secondStop).toBe(firstStop);
    await stopStarted;
    expect(stopCalls).toBe(1);

    releaseStop();
    await Promise.all([firstStop, secondStop]);
    expect(stopCalls).toBe(1);
    expect(engine.state).toBe("stopped");
  });
});

describe("CoreEngine dependency memory capability recovery", () => {
  it("revokes successful dependents but preserves failed dependents and their dependencies until retry", async () => {
    const { GuardedMemoryPort } = await import("../../src/core/guarded-memory-port.js");
    const { InMemoryMemoryStore } = await import("../../src/core/in-memory-memory-store.js");
    const store = new InMemoryMemoryStore();
    const capabilities = new Map<string, InstanceType<typeof GuardedMemoryPort>>();
    const calls: string[] = [];
    let alphaAttempts = 0;
    const engine = new CoreEngine({
      memory: (moduleId) => {
        const capability = new GuardedMemoryPort({
          store,
          policy: { evaluate: async () => ({ effect: "allow" as const, reason: "dependency cleanup test" }) },
          audit: { publishDecision: async () => true, publishFailure: async () => undefined },
          scope: { tenantId: "tenant", actorId: "actor", moduleId }
        });
        capabilities.set(moduleId, capability);
        return capability;
      }
    });
    engine.register({
      id: "foundation",
      version: "1.0.0",
      initialize: (context) => { void context.memory; },
      stop: async () => { calls.push("foundation"); }
    });
    engine.register({
      id: "alpha",
      version: "1.0.0",
      dependencies: ["foundation"],
      initialize: (context) => { void context.memory; },
      stop: async () => {
        alphaAttempts += 1;
        calls.push("alpha:" + alphaAttempts);
        if (alphaAttempts === 1) throw new Error("temporary alpha cleanup failure");
      }
    });
    engine.register({
      id: "beta",
      version: "1.0.0",
      dependencies: ["foundation"],
      initialize: (context) => { void context.memory; },
      stop: async () => { calls.push("beta"); }
    });

    await engine.initialize();
    await expect(engine.stop()).rejects.toMatchObject({ code: "MODULE_STOP_FAILED" });

    expect(calls).toEqual(["beta", "alpha:1"]);
    await expect(capabilities.get("beta")!.read({ namespace: "probe", key: "x" }))
      .rejects.toMatchObject({ code: "MEMORY_CAPABILITY_REVOKED" });
    await expect(capabilities.get("alpha")!.read({ namespace: "probe", key: "x" }))
      .resolves.toBeNull();
    await expect(capabilities.get("foundation")!.read({ namespace: "probe", key: "x" }))
      .resolves.toBeNull();

    await engine.stop();

    expect(calls).toEqual(["beta", "alpha:1", "alpha:2", "foundation"]);
    for (const capability of capabilities.values()) {
      await expect(capability.read({ namespace: "probe", key: "after-retry" }))
        .rejects.toMatchObject({ code: "MEMORY_CAPABILITY_REVOKED" });
    }
    expect(engine.state).toBe("stopped");
  });
});


describe("CoreEngine stop-hook timeout recovery", () => {
  it("waits for the original timed-out stop hook before revoking its memory capability", async () => {
    const { GuardedMemoryPort } = await import("../../src/core/guarded-memory-port.js");
    const { InMemoryMemoryStore } = await import("../../src/core/in-memory-memory-store.js");
    let releaseStop!: () => void;
    let signalStopStarted!: () => void;
    const stopGate = new Promise<void>((resolve) => { releaseStop = resolve; });
    const stopStarted = new Promise<void>((resolve) => { signalStopStarted = resolve; });
    const store = new InMemoryMemoryStore();
    let memory!: InstanceType<typeof GuardedMemoryPort>;
    let stopCalls = 0;
    const engine = new CoreEngine({
      protectedOperationShutdown: { drainDeadlineMs: 20 },
      memory: (moduleId) => {
        memory = new GuardedMemoryPort({
          store,
          policy: { evaluate: async () => ({ effect: "allow" as const, reason: "stop retry test" }) },
          audit: { publishDecision: async () => true, publishFailure: async () => undefined },
          scope: { tenantId: "tenant", actorId: "actor", moduleId }
        });
        return memory;
      }
    });
    engine.register({
      id: "slow-stop-memory-worker",
      version: "1.0.0",
      initialize: () => undefined,
      stop: async (context) => {
        stopCalls += 1;
        signalStopStarted();
        await stopGate;
        await context.memory!.write(
          { namespace: "shutdown", key: "final" },
          "written-after-first-timeout"
        );
      }
    });

    await engine.initialize();
    await engine.start();
    const firstStop = engine.stop();
    await stopStarted;
    await expect(firstStop).rejects.toMatchObject({ code: "MODULE_STOP_FAILED" });
    expect(engine.state).toBe("failed");
    await expect(memory.read({ namespace: "shutdown", key: "probe" })).resolves.toBeNull();

    releaseStop();
    await engine.stop();

    expect(stopCalls).toBe(1);
    expect(await store.read({ namespace: "tenant/shutdown", key: "final" }))
      .toBe('"written-after-first-timeout"');
    await expect(memory.read({ namespace: "shutdown", key: "late" })).rejects.toMatchObject({
      code: "MEMORY_CAPABILITY_REVOKED"
    });
    expect(engine.state).toBe("stopped");
  });
});


describe("CoreEngine stop-hook deadline boundary", () => {
  it("does not turn a completed stop hook into a timeout because its continuation resumes later", async () => {
    const engine = new CoreEngine({
      protectedOperationShutdown: { drainDeadlineMs: 15 }
    });
    engine.register({
      id: "deadline-stop-hook",
      version: "1.0.0",
      stop: () => undefined
    });
    await engine.initialize();
    await engine.start();

    // Deadline starts at 100 (115 total); shutdown and hook admission both
    // observe 100. The old post-race clock check then observed 120 and
    // incorrectly converted the already-won completion race into a timeout.
    const clock = [100, 100, 100, 120];
    const now = vi.spyOn(performance, "now").mockImplementation(() => clock.shift() ?? 120);
    try {
      await expect(engine.stop()).resolves.toBeUndefined();
      expect(engine.state).toBe("stopped");
    } finally {
      now.mockRestore();
    }
  });
});

describe("CoreEngine stop-hook tracking release", () => {
  it("releases a settled successful stop-hook promise after cleanup", async () => {
    const engine = new CoreEngine();
    engine.register({
      id: "settled-stop-hook",
      version: "1.0.0",
      stop: async () => undefined
    });

    await engine.initialize();
    await engine.start();
    await engine.stop();

    const internals = engine as unknown as {
      moduleStopInFlight: Map<string, Promise<void>>;
    };
    expect(internals.moduleStopInFlight.has("settled-stop-hook")).toBe(false);
    expect(internals.moduleStopInFlight.size).toBe(0);
  });
});
