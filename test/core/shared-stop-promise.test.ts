import { describe, expect, it, vi } from "vitest";
import { CoreEngine } from "../../src/core/core-engine.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Shared Stop Promise (Revision v5)", () => {
  it("S01: returns the exact same promise to concurrent stop callers", async () => {
    const engine = new CoreEngine();
    const gate = deferred();
    const stop = vi.fn(() => gate.promise);
    engine.register({ id: "worker", version: "1.0.0", stop });
    await engine.initialize();

    const first = engine.stop();
    const second = engine.stop();
    expect(first).toBe(second);
    expect(stop).not.toHaveBeenCalled();

    gate.resolve();
    await Promise.all([first, second]);
    expect(stop).toHaveBeenCalledOnce();
    expect(engine.state).toBe("stopped");
  });

  it("S02: shares one shutdown operation across many simultaneous callers", async () => {
    const engine = new CoreEngine();
    const gate = deferred();
    const stop = vi.fn(() => gate.promise);
    engine.register({ id: "worker", version: "1.0.0", stop });
    await engine.initialize();

    const callers = Array.from({ length: 12 }, () => engine.stop());
    expect(callers.every((promise) => promise === callers[0])).toBe(true);
    gate.resolve();
    await Promise.all(callers);

    expect(stop).toHaveBeenCalledOnce();
  });

  it("S03: concurrent callers share the same rejected promise when cleanup fails", async () => {
    const engine = new CoreEngine();
    const gate = deferred();
    const stop = vi.fn(async () => {
      await gate.promise;
      throw new Error("cleanup failed");
    });
    engine.register({ id: "worker", version: "1.0.0", stop });
    await engine.initialize();

    const first = engine.stop();
    const second = engine.stop();
    expect(first).toBe(second);
    gate.resolve();

    const results = await Promise.allSettled([first, second]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(stop).toHaveBeenCalledOnce();
    expect(engine.state).toBe("failed");
  });

  it("S04: clears a rejected stop promise so a later call can retry cleanup", async () => {
    const engine = new CoreEngine();
    let attempts = 0;
    engine.register({
      id: "worker",
      version: "1.0.0",
      stop: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary failure");
      }
    });
    await engine.initialize();

    const first = engine.stop();
    await expect(first).rejects.toThrow(/failed to stop/i);
    const retry = engine.stop();

    expect(retry).not.toBe(first);
    await retry;
    expect(attempts).toBe(2);
    expect(engine.state).toBe("stopped");
  });

  it("S05: stopping before initialization is idempotent", async () => {
    const engine = new CoreEngine();
    const stop = vi.fn();
    engine.register({ id: "worker", version: "1.0.0", stop });

    await engine.stop();
    await engine.stop();

    expect(engine.state).toBe("stopped");
    expect(stop).not.toHaveBeenCalled();
  });

  it("S06: rejects stop during initialization without racing module initialization", async () => {
    const engine = new CoreEngine();
    const gate = deferred();
    const stop = vi.fn();
    engine.register({
      id: "worker",
      version: "1.0.0",
      initialize: () => gate.promise,
      stop
    });

    const initializing = engine.initialize();
    expect(engine.state).toBe("initializing");
    await expect(engine.stop()).rejects.toThrow(/while it is "initializing"/i);
    expect(stop).not.toHaveBeenCalled();

    gate.resolve();
    await initializing;
    await engine.stop();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("S07: rejects stop during module startup and allows orderly stop after startup", async () => {
    const engine = new CoreEngine();
    const gate = deferred();
    const stop = vi.fn();
    engine.register({
      id: "worker",
      version: "1.0.0",
      start: () => gate.promise,
      stop
    });
    await engine.initialize();

    const starting = engine.start();
    expect(engine.state).toBe("starting");
    await expect(engine.stop()).rejects.toThrow(/while it is "starting"/i);
    expect(stop).not.toHaveBeenCalled();

    gate.resolve();
    await starting;
    await engine.stop();
    expect(stop).toHaveBeenCalledOnce();
    expect(engine.state).toBe("stopped");
  });
});
