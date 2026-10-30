import { EventEmitter } from "node:events";
import express from "express";
import { describe, expect, it, vi } from "vitest";
import { CoreEngine } from "../../src/core/core-engine.js";
import { startServerRuntime } from "../../src/core/server-runtime.js";

class FakeProcess extends EventEmitter {
  exitCode = 0;
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function runtimeFixture(core: CoreEngine, port = 0) {
  const fakeProcess = new FakeProcess();
  const logger = { info: vi.fn(), error: vi.fn() };
  const exit = vi.fn();
  const app = express();

  return {
    app,
    fakeProcess,
    logger,
    exit,
    start: () => startServerRuntime({
      app,
      core,
      process: fakeProcess as unknown as NodeJS.Process,
      exit,
      logger,
      host: "127.0.0.1",
      port,
      environment: "test",
      drainTimeoutMs: 1_000
    })
  };
}

describe("Core Engine shutdown integration and regression (Revision v5)", () => {
  it("I01: signal during real CoreEngine initialization waits and prevents module start", async () => {
    const engine = new CoreEngine();
    const initStarted = deferred();
    const initGate = deferred();
    const calls: string[] = [];
    engine.register({
      id: "platform",
      version: "1.0.0",
      initialize: async () => {
        calls.push("initialize:start");
        initStarted.resolve();
        await initGate.promise;
        calls.push("initialize:end");
      },
      start: () => { calls.push("start"); },
      stop: () => { calls.push("stop"); }
    });
    const setup = runtimeFixture(engine);

    const starting = setup.start();
    await initStarted.promise;
    setup.fakeProcess.emit("SIGTERM");
    initGate.resolve();

    const runtime = await starting;
    expect(runtime.server.listening).toBe(false);
    await runtime.shutdown();

    expect(calls).toEqual(["initialize:start", "initialize:end", "stop"]);
    expect(engine.state).toBe("stopped");
    expect(setup.exit).toHaveBeenCalledOnce();
  });

  it("I02: signal during real CoreEngine start waits for the hook before cleanup", async () => {
    const engine = new CoreEngine();
    const startStarted = deferred();
    const startGate = deferred();
    const calls: string[] = [];
    engine.register({
      id: "worker",
      version: "1.0.0",
      initialize: () => { calls.push("initialize"); },
      start: async () => {
        calls.push("start:begin");
        startStarted.resolve();
        await startGate.promise;
        calls.push("start:end");
      },
      stop: () => { calls.push("stop"); }
    });
    const setup = runtimeFixture(engine);

    const starting = setup.start();
    await startStarted.promise;
    setup.fakeProcess.emit("SIGINT");
    expect(calls).toEqual(["initialize", "start:begin"]);

    startGate.resolve();
    const runtime = await starting;
    expect(runtime.server.listening).toBe(false);
    await runtime.shutdown();

    expect(calls).toEqual(["initialize", "start:begin", "start:end", "stop"]);
    expect(engine.state).toBe("stopped");
    expect(setup.exit).toHaveBeenCalledOnce();
  });

  it("I03: real HTTP E2E serves traffic and concurrent signals stop the real CoreEngine once", async () => {
    const engine = new CoreEngine();
    const calls: string[] = [];
    engine.register({
      id: "http",
      version: "1.0.0",
      initialize: () => { calls.push("initialize"); },
      start: () => { calls.push("start"); },
      stop: () => { calls.push("stop"); }
    });
    const setup = runtimeFixture(engine);
    setup.app.get("/revision-v5-probe", (_request, response) => {
      response.status(200).send("ready");
    });

    const runtime = await setup.start();
    await new Promise<void>((resolve) => {
      if (runtime.server.listening) resolve();
      else runtime.server.once("listening", resolve);
    });
    const address = runtime.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected an active TCP listener.");
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/revision-v5-probe`, {
      headers: { connection: "close" }
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ready");

    setup.fakeProcess.emit("SIGINT");
    setup.fakeProcess.emit("SIGTERM");
    await runtime.shutdown();

    expect(calls).toEqual(["initialize", "start", "stop"]);
    expect(engine.state).toBe("stopped");
    expect(setup.exit).toHaveBeenCalledOnce();
    expect(setup.exit).toHaveBeenCalledWith(0);
    expect(runtime.server.listening).toBe(false);
  });

  it("I04: startup signal plus failed rollback retries only the remaining resource and exits non-zero", async () => {
    const engine = new CoreEngine();
    const initStarted = deferred();
    const initGate = deferred();
    let stopAttempts = 0;
    engine.register({
      id: "partially-initialized",
      version: "1.0.0",
      initialize: async () => {
        initStarted.resolve();
        await initGate.promise;
        throw new Error("initialization failed");
      },
      stop: () => {
        stopAttempts += 1;
        if (stopAttempts === 1) throw new Error("first rollback cleanup failed");
      }
    });
    const setup = runtimeFixture(engine);

    const starting = setup.start();
    await initStarted.promise;
    setup.fakeProcess.emit("SIGTERM");
    initGate.resolve();

    await expect(starting).rejects.toThrow(/initialization and rollback failed/i);

    expect(stopAttempts).toBe(2);
    expect(engine.state).toBe("stopped");
    expect(setup.exit).toHaveBeenCalledOnce();
    expect(setup.exit).toHaveBeenCalledWith(1);
    expect(setup.fakeProcess.exitCode).toBe(1);
  });
});
