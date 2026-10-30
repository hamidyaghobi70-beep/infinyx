import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import type { Express } from "express";
import { describe, expect, it, vi } from "vitest";
import { startServerRuntime } from "../../src/core/server-runtime.js";
import type { CoreEngine } from "../../src/core/core-engine.js";

class FakeProcess extends EventEmitter {
  exitCode = 0;
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fixture(options?: {
  readonly initialize?: () => Promise<void>;
  readonly start?: () => Promise<void>;
  readonly stop?: () => Promise<void>;
}) {
  const fakeProcess = new FakeProcess();
  const close = vi.fn((callback: (error?: Error) => void) => callback());
  const closeAllConnections = vi.fn();
  const server = { listening: true, close, closeAllConnections } as unknown as Server;
  const listen = vi.fn(() => server);
  const app = { listen } as unknown as Express;
  const core = {
    initialize: vi.fn(options?.initialize ?? (async () => undefined)),
    start: vi.fn(options?.start ?? (async () => undefined)),
    stop: vi.fn(options?.stop ?? (async () => undefined))
  } as unknown as CoreEngine;
  const logger = { info: vi.fn(), error: vi.fn() };
  const exit = vi.fn();

  return {
    fakeProcess,
    listen,
    core,
    logger,
    exit,
    start: () => startServerRuntime({
      app,
      core,
      process: fakeProcess as unknown as NodeJS.Process,
      exit,
      logger,
      host: "127.0.0.1",
      port: 3000,
      environment: "test",
      drainTimeoutMs: 50
    })
  };
}

describe("Startup Signal Handling (Revision v5)", () => {
  it("R01: installs all process handlers before initialization begins", async () => {
    const setup = fixture();
    vi.mocked(setup.core.initialize).mockImplementation(async () => {
      expect(setup.fakeProcess.listenerCount("SIGINT")).toBe(1);
      expect(setup.fakeProcess.listenerCount("SIGTERM")).toBe(1);
      expect(setup.fakeProcess.listenerCount("uncaughtException")).toBe(1);
      expect(setup.fakeProcess.listenerCount("unhandledRejection")).toBe(1);
    });

    const runtime = await setup.start();
    expect(setup.listen).toHaveBeenCalledOnce();
    await runtime.shutdown();
  });

  it("R02: a signal during initialization waits for initialize and skips module start", async () => {
    const gate = deferred();
    const setup = fixture({ initialize: () => gate.promise });
    const starting = setup.start();
    await Promise.resolve();

    setup.fakeProcess.emit("SIGTERM");
    await Promise.resolve();
    expect(setup.core.stop).not.toHaveBeenCalled();

    gate.resolve();
    const runtime = await starting;
    expect(setup.core.start).not.toHaveBeenCalled();
    expect(setup.listen).not.toHaveBeenCalled();
    expect(runtime.server.listening).toBe(false);

    await runtime.shutdown();
    expect(setup.core.stop).toHaveBeenCalledOnce();
    expect(setup.exit).toHaveBeenCalledOnce();
  });

  it("R03: a signal during module start waits for start to settle before stopping", async () => {
    const gate = deferred();
    const setup = fixture({ start: () => gate.promise });
    const starting = setup.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(setup.core.start).toHaveBeenCalledOnce();
    setup.fakeProcess.emit("SIGINT");
    await Promise.resolve();
    expect(setup.core.stop).not.toHaveBeenCalled();

    gate.resolve();
    const runtime = await starting;
    expect(setup.listen).not.toHaveBeenCalled();
    await runtime.shutdown();

    expect(setup.core.stop).toHaveBeenCalledOnce();
    expect(setup.exit).toHaveBeenCalledOnce();
  });

  it("R04: simultaneous signals during initialization converge on one shutdown", async () => {
    const gate = deferred();
    const setup = fixture({ initialize: () => gate.promise });
    const starting = setup.start();
    await Promise.resolve();

    setup.fakeProcess.emit("SIGINT");
    setup.fakeProcess.emit("SIGTERM");
    gate.resolve();
    const runtime = await starting;
    await runtime.shutdown();

    expect(setup.core.start).not.toHaveBeenCalled();
    expect(setup.core.stop).toHaveBeenCalledOnce();
    expect(setup.exit).toHaveBeenCalledOnce();
  });

  it("R05: a fatal event during startup preserves a non-zero exit code", async () => {
    const gate = deferred();
    const setup = fixture({ initialize: () => gate.promise });
    const starting = setup.start();
    await Promise.resolve();

    setup.fakeProcess.emit("uncaughtException", new Error("fatal during initialize"));
    gate.resolve();
    const runtime = await starting;
    await runtime.shutdown();

    expect(setup.core.stop).toHaveBeenCalledOnce();
    expect(setup.exit).toHaveBeenCalledOnce();
    expect(setup.exit).toHaveBeenCalledWith(1);
    expect(setup.fakeProcess.exitCode).toBe(1);
  });

  it("R06: an unhandled rejection during module start waits and exits fatally", async () => {
    const gate = deferred();
    const setup = fixture({ start: () => gate.promise });
    const starting = setup.start();
    await Promise.resolve();
    await Promise.resolve();

    setup.fakeProcess.emit("unhandledRejection", new Error("fatal during start"));
    gate.resolve();
    const runtime = await starting;
    await runtime.shutdown();

    expect(setup.core.stop).toHaveBeenCalledOnce();
    expect(setup.exit).toHaveBeenCalledWith(1);
    expect(setup.fakeProcess.exitCode).toBe(1);
  });

  it("R07: if startup fails after a signal, shutdown waits, retries cleanup, and exits non-zero", async () => {
    const gate = deferred();
    const setup = fixture({ initialize: () => gate.promise });
    const starting = setup.start();
    await Promise.resolve();

    setup.fakeProcess.emit("SIGTERM");
    gate.reject(new Error("initialization failed"));
    await expect(starting).rejects.toThrow(/initialization failed/i);

    expect(setup.core.start).not.toHaveBeenCalled();
    expect(setup.core.stop).toHaveBeenCalledOnce();
    expect(setup.exit).toHaveBeenCalledOnce();
    expect(setup.exit).toHaveBeenCalledWith(1);
  });

  it("R08: normal startup listens only after initialize and start have completed", async () => {
    const calls: string[] = [];
    const setup = fixture({
      initialize: async () => { calls.push("initialize"); },
      start: async () => { calls.push("start"); }
    });
    setup.listen.mockImplementation(() => {
      calls.push("listen");
      expect(setup.fakeProcess.listenerCount("SIGINT")).toBe(1);
      return { listening: true } as unknown as Server;
    });

    const runtime = await setup.start();
    expect(calls).toEqual(["initialize", "start", "listen"]);
    await runtime.shutdown();
  });

  it("R09: a signal during startup never opens an HTTP listener", async () => {
    const gate = deferred();
    const setup = fixture({ initialize: () => gate.promise });
    const starting = setup.start();
    await Promise.resolve();

    setup.fakeProcess.emit("SIGTERM");
    gate.resolve();
    const runtime = await starting;

    expect(setup.listen).not.toHaveBeenCalled();
    expect(runtime.server.listening).toBe(false);
    await runtime.shutdown();
  });

  it("R10: shutdown remains injectable and invokes the exit callback exactly once", async () => {
    const setup = fixture();
    const runtime = await setup.start();

    const first = runtime.shutdown("manual");
    const second = runtime.shutdown("manual-again");
    expect(first).toBe(second);
    await Promise.all([first, second]);

    expect(setup.exit).toHaveBeenCalledOnce();
    expect(setup.exit).toHaveBeenCalledWith(0);
    expect(setup.fakeProcess.exitCode).toBe(0);
  });
});
