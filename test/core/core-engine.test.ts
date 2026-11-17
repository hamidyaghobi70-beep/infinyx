import { describe, expect, it } from "vitest";
import { CoreEngine } from "../../src/core/core-engine.js";

describe("CoreEngine", () => {
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
