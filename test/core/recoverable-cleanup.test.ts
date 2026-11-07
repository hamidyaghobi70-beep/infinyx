import { describe, expect, it, vi } from "vitest";
import { CoreEngine } from "../../src/core/core-engine.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Recoverable Cleanup (Revision v5)", () => {
  it("C01: cleans initialized modules in reverse dependency order", async () => {
    const engine = new CoreEngine();
    const calls: string[] = [];
    engine.register({
      id: "platform",
      version: "1.0.0",
      stop: () => { calls.push("platform"); }
    });
    engine.register({
      id: "api",
      version: "1.0.0",
      dependencies: ["platform"],
      stop: () => { calls.push("api"); }
    });

    await engine.initialize();
    await engine.stop();

    expect(calls).toEqual(["api", "platform"]);
    expect(engine.state).toBe("stopped");
  });

  it("C02: retains a module whose cleanup fails so a later stop can retry it", async () => {
    const engine = new CoreEngine();
    let attempts = 0;
    engine.register({
      id: "worker",
      version: "1.0.0",
      stop: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary cleanup failure");
      }
    });

    await engine.initialize();
    await expect(engine.stop()).rejects.toThrow(/failed to stop/i);
    expect(engine.state).toBe("failed");
    expect(engine.getModuleStates().get("worker")).toBe("failed");

    await engine.stop();
    expect(attempts).toBe(2);
    expect(engine.getModuleStates().get("worker")).toBe("stopped");
    expect(engine.state).toBe("stopped");
  });

  it("C03: removes successfully cleaned modules from the pending cleanup set", async () => {
    const engine = new CoreEngine();
    let stableCalls = 0;
    let flakyCalls = 0;
    engine.register({
      id: "stable",
      version: "1.0.0",
      stop: () => { stableCalls += 1; }
    });
    engine.register({
      id: "flaky",
      version: "1.0.0",
      stop: () => {
        flakyCalls += 1;
        if (flakyCalls === 1) throw new Error("retry me");
      }
    });

    await engine.initialize();
    await expect(engine.stop()).rejects.toThrow(/failed to stop/i);
    expect(engine.getModuleStates().get("stable")).toBe("stopped");
    expect(engine.getModuleStates().get("flaky")).toBe("failed");

    const pending = (engine as unknown as { initializedModules: { id: string }[] }).initializedModules;
    expect(pending.map((module) => module.id)).toEqual(["flaky"]);
    expect(stableCalls).toBe(1);
  });

  it("C04: retries only failed resources and never cleans successful resources twice", async () => {
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
        if (calls.flaky === 1) throw new Error("first attempt fails");
      }
    });

    await engine.initialize();
    await expect(engine.stop()).rejects.toThrow(/failed to stop/i);
    await engine.stop();

    expect(calls).toEqual({ stable: 1, flaky: 2 });
    expect(engine.state).toBe("stopped");
  });

  it("C05: concurrent cleanup attempts share one in-flight cleanup per module", async () => {
    const engine = new CoreEngine();
    const gate = deferred();
    const stop = vi.fn(() => gate.promise);
    engine.register({ id: "worker", version: "1.0.0", stop });
    await engine.initialize();

    const internal = engine as unknown as {
      cleanupInitializedModules(): Promise<unknown[]>;
    };
    const first = internal.cleanupInitializedModules.call(engine);
    expect(engine.getModuleStates().get("worker")).toBe("cleaning");
    const second = internal.cleanupInitializedModules.call(engine);

    expect(stop).toHaveBeenCalledOnce();
    gate.resolve();
    await Promise.all([first, second]);

    expect(stop).toHaveBeenCalledOnce();
    expect(engine.getModuleStates().get("worker")).toBe("stopped");
  });

  it("C06: attempts every module, reports all cleanup failures, and retains them for retry", async () => {
    const engine = new CoreEngine();
    const calls = { first: 0, second: 0 };
    let shouldFail = true;
    engine.register({
      id: "first",
      version: "1.0.0",
      stop: () => {
        calls.first += 1;
        if (shouldFail) throw new Error("first failed");
      }
    });
    engine.register({
      id: "second",
      version: "1.0.0",
      stop: () => {
        calls.second += 1;
        if (shouldFail) throw new Error("second failed");
      }
    });

    await engine.initialize();
    await expect(engine.stop()).rejects.toThrow(/failed to stop/i);
    expect(calls).toEqual({ first: 1, second: 1 });
    expect(engine.getModuleStates().get("first")).toBe("failed");
    expect(engine.getModuleStates().get("second")).toBe("failed");

    shouldFail = false;
    await engine.stop();
    expect(calls).toEqual({ first: 2, second: 2 });
    expect(engine.state).toBe("stopped");
  });

  it("C07: retries partial-initialization rollback when that module cleanup fails", async () => {
    const engine = new CoreEngine();
    let dependencyStops = 0;
    let brokenStops = 0;
    engine.register({
      id: "platform",
      version: "1.0.0",
      stop: () => { dependencyStops += 1; }
    });
    engine.register({
      id: "broken",
      version: "1.0.0",
      dependencies: ["platform"],
      initialize: () => { throw new Error("partial initialization"); },
      stop: () => {
        brokenStops += 1;
        if (brokenStops === 1) throw new Error("rollback cleanup failed");
      }
    });

    await expect(engine.initialize()).rejects.toThrow(/rollback failed/i);
    expect(engine.getModuleStates().get("broken")).toBe("failed");
    expect(engine.getModuleStates().get("platform")).toBe("stopped");
    expect(dependencyStops).toBe(1);
    expect(brokenStops).toBe(1);

    await engine.stop();
    expect(dependencyStops).toBe(1);
    expect(brokenStops).toBe(2);
    expect(engine.state).toBe("stopped");
  });

  it("C08: repeated stop after successful cleanup is idempotent", async () => {
    const engine = new CoreEngine();
    const stop = vi.fn();
    engine.register({ id: "worker", version: "1.0.0", stop });

    await engine.initialize();
    await engine.stop();
    await engine.stop();

    expect(stop).toHaveBeenCalledOnce();
    expect(engine.state).toBe("stopped");
  });
});
