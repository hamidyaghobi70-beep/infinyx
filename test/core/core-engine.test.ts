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
