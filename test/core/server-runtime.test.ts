import { EventEmitter } from "node:events";
import express from "express";
import type { Server } from "node:http";
import type { Express } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startServerRuntime } from "../../src/core/server-runtime.js";
import type { CoreEngine } from "../../src/core/core-engine.js";

class FakeProcess extends EventEmitter {
  exitCode = 0;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(options?: {
  readonly stop?: () => Promise<void>;
  readonly close?: (callback: (error?: Error) => void) => void;
  readonly drainTimeoutMs?: number;
}) {
  const fakeProcess = new FakeProcess();
  const close = vi.fn(options?.close ?? ((callback) => callback()));
  const closeAllConnections = vi.fn();
  const server = {
    close,
    closeAllConnections
  } as unknown as Server;
  const listen = vi.fn((_port: number, _host: string, _callback: () => void) => server);
  const app = { listen } as unknown as Express;
  const core = {
    initialize: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined),
    stop: vi.fn(options?.stop ?? (async () => undefined))
  } as unknown as CoreEngine;
  const logger = {
    info: vi.fn(),
    error: vi.fn()
  };
  const exit = vi.fn();

  return {
    fakeProcess,
    close,
    closeAllConnections,
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
      drainTimeoutMs: options?.drainTimeoutMs
    })
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("server shutdown runtime", () => {
  it("installs all process handlers before the HTTP server begins listening", async () => {
    const setup = fixture();
    setup.listen.mockImplementation(() => {
      expect(setup.fakeProcess.listenerCount("SIGINT")).toBe(1);
      expect(setup.fakeProcess.listenerCount("SIGTERM")).toBe(1);
      expect(setup.fakeProcess.listenerCount("uncaughtException")).toBe(1);
      expect(setup.fakeProcess.listenerCount("unhandledRejection")).toBe(1);
      return {
        close: setup.close,
        closeAllConnections: setup.closeAllConnections
      } as unknown as Server;
    });

    await setup.start();
    expect(setup.listen).toHaveBeenCalledOnce();
  });

  it("shares one shutdown and one exit across simultaneous SIGINT and SIGTERM", async () => {
    const stopGate = deferred();
    const setup = fixture({ stop: () => stopGate.promise });
    const runtime = await setup.start();

    setup.fakeProcess.emit("SIGINT");
    setup.fakeProcess.emit("SIGTERM");
    await Promise.resolve();

    expect(setup.close).toHaveBeenCalledOnce();
    expect(setup.core.stop).toHaveBeenCalledOnce();
    expect(setup.exit).not.toHaveBeenCalled();

    stopGate.resolve();
    await runtime.shutdown();

    expect(setup.core.stop).toHaveBeenCalledTimes(1);
    expect(setup.exit).toHaveBeenCalledTimes(1);
    expect(setup.exit).toHaveBeenCalledWith(0);
  });

  it("preserves a fatal exit code when a fatal event arrives during signal shutdown", async () => {
    const stopGate = deferred();
    const setup = fixture({ stop: () => stopGate.promise });
    const runtime = await setup.start();

    setup.fakeProcess.emit("SIGTERM");
    await Promise.resolve();
    setup.fakeProcess.emit("uncaughtException", new Error("fatal during shutdown"));
    setup.fakeProcess.emit("unhandledRejection", new Error("second fatal"));

    stopGate.resolve();
    await runtime.shutdown();

    expect(setup.core.stop).toHaveBeenCalledTimes(1);
    expect(setup.exit).toHaveBeenCalledTimes(1);
    expect(setup.exit).toHaveBeenCalledWith(1);
    expect(setup.fakeProcess.exitCode).toBe(1);
  });

  it("forces remaining HTTP connections closed after the configured drain timeout", async () => {
    vi.useFakeTimers();
    const setup = fixture({
      close: () => undefined,
      drainTimeoutMs: 25
    });
    const runtime = await setup.start();

    setup.fakeProcess.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(25);
    await runtime.shutdown();

    expect(setup.closeAllConnections).toHaveBeenCalledOnce();
    expect(setup.core.stop).toHaveBeenCalledOnce();
    expect(setup.exit).toHaveBeenCalledOnce();
    expect(setup.exit).toHaveBeenCalledWith(1);
  });

  it("does not invoke the real process exit in tests", async () => {
    const setup = fixture();
    const runtime = await setup.start();

    setup.fakeProcess.emit("SIGINT");
    await runtime.shutdown();

    expect(setup.exit).toHaveBeenCalledOnce();
    expect(setup.fakeProcess.exitCode).toBe(0);
  });
});
