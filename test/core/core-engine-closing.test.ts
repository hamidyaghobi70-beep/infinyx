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
    engine.register({
      id: "platform",
      version: "1.0.0",
      initialize: async () => {
        entered.resolve();
        await gate.promise;
      }
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

    await engine.stop();
    expect(engine.state).toBe("stopped");
  });

  it("C02: a close request before initialization prevents new startup admission", async () => {
    const engine = new CoreEngine();
    engine.requestClose();

    expect(engine.state).toBe("closing");
    await expect(engine.initialize()).rejects.toThrow(/closing/i);
    await engine.stop();
    expect(engine.state).toBe("stopped");
  });
});
