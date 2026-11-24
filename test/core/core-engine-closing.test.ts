import { describe, expect, it } from "vitest";
import { CoreEngine } from "../../src/core/core-engine.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("CoreEngine CLOSING lifecycle", () => {
  it("C01: closes admission while an in-flight initialize hook settles, then stops", async () => {
    const engine = new CoreEngine();
    const entered = deferred();
    const gate = deferred();
    const calls: string[] = [];
    engine.register({
      id: "platform",
      version: "1.0.0",
      initialize: async () => {
        calls.push("platform:init:start");
        entered.resolve();
        await gate.promise;
        calls.push("platform:init:end");
      },
      stop: () => { calls.push("platform:stop"); }
    });
    engine.register({
      id: "worker",
      version: "1.0.0",
      initialize: () => { calls.push("worker:init"); },
      start: () => { calls.push("worker:start"); },
      stop: () => { calls.push("worker:stop"); }
    });

    const initialization = engine.initialize();
    await entered.promise;
    engine.requestClose();

    expect(engine.state).toBe("closing");
    expect(() => engine.register({ id: "late", version: "1.0.0" }))
      .toThrow(/before initialization/i);
    await expect(engine.start()).rejects.toThrow(/closing/i);

    gate.resolve();
    await initialization;
    expect(engine.state).toBe("closing");
    expect(calls).toEqual(["platform:init:start", "platform:init:end"]);

    await engine.stop();
    expect(engine.state).toBe("stopped");
    expect(calls).toEqual(["platform:init:start", "platform:init:end", "platform:stop"]);
  });

  it("C02: a close request before initialization prevents new startup admission", async () => {
    const engine = new CoreEngine();
    engine.requestClose();

    expect(engine.state).toBe("closing");
    await expect(engine.initialize()).rejects.toThrow(/closing/i);
    await engine.stop();
    expect(engine.state).toBe("stopped");
  });
  it("C03: reports failed cleanup honestly while keeping admission closed, then permits retry", async () => {
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
    await engine.start();
    engine.requestClose();

    await expect(engine.stop()).rejects.toThrow(/failed to stop/i);
    expect(engine.state).toBe("failed");

    await engine.stop();
    expect(engine.state).toBe("stopped");
    expect(attempts).toBe(2);
  });

  it("C04: does not begin another module after an in-flight start settles in CLOSING", async () => {
    const engine = new CoreEngine();
    const entered = deferred();
    const gate = deferred();
    const calls: string[] = [];
    engine.register({
      id: "platform",
      version: "1.0.0",
      start: async () => {
        calls.push("platform:start:begin");
        entered.resolve();
        await gate.promise;
        calls.push("platform:start:end");
      },
      stop: () => { calls.push("platform:stop"); }
    });
    engine.register({
      id: "worker",
      version: "1.0.0",
      start: () => { calls.push("worker:start"); },
      stop: () => { calls.push("worker:stop"); }
    });

    await engine.initialize();
    const starting = engine.start();
    await entered.promise;
    engine.requestClose();
    expect(engine.state).toBe("closing");

    gate.resolve();
    await starting;
    expect(calls).toEqual(["platform:start:begin", "platform:start:end"]);
    await engine.stop();
    expect(engine.state).toBe("stopped");
    expect(calls).toEqual([
      "platform:start:begin",
      "platform:start:end",
      "worker:stop",
      "platform:stop"
    ]);
  });

});
