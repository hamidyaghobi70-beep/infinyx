import { describe, expect, it, vi } from "vitest";
import { createShutdownCoordinator } from "../../src/core/shutdown-coordinator.js";

describe("createShutdownCoordinator", () => {
  it("shares one shutdown operation for concurrent and repeated signals", async () => {
    let releaseClose!: () => void;
    const closeServer = vi.fn(
      () => new Promise<void>((resolve) => { releaseClose = resolve; })
    );
    const stopCore = vi.fn(async () => {});
    const onStart = vi.fn();
    const onFailure = vi.fn();
    const shutdown = createShutdownCoordinator({
      closeServer,
      stopCore,
      onStart,
      onFailure
    });

    const first = shutdown("SIGINT");
    const second = shutdown("SIGTERM");

    expect(second).toBe(first);
    expect(closeServer).toHaveBeenCalledOnce();
    expect(stopCore).not.toHaveBeenCalled();
    expect(onStart).toHaveBeenCalledOnce();
    expect(onStart).toHaveBeenCalledWith("SIGINT");

    releaseClose();
    await Promise.all([first, second, shutdown("SIGINT")]);

    expect(closeServer).toHaveBeenCalledOnce();
    expect(stopCore).toHaveBeenCalledOnce();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("still stops Core Engine when HTTP server close fails", async () => {
    const closeError = new Error("HTTP close failed");
    const closeServer = vi.fn(async () => { throw closeError; });
    const stopCore = vi.fn(async () => {});
    const onFailure = vi.fn();
    const shutdown = createShutdownCoordinator({
      closeServer,
      stopCore,
      onFailure
    });

    await shutdown("SIGTERM");

    expect(closeServer).toHaveBeenCalledOnce();
    expect(stopCore).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledWith("http-server", closeError);
  });

  it("records Core Engine cleanup failures without retrying cleanup", async () => {
    const stopError = new Error("Core stop failed");
    const closeServer = vi.fn(async () => {});
    const stopCore = vi.fn(async () => { throw stopError; });
    const onFailure = vi.fn();
    const shutdown = createShutdownCoordinator({
      closeServer,
      stopCore,
      onFailure
    });

    await Promise.all([shutdown("SIGINT"), shutdown("SIGTERM")]);

    expect(closeServer).toHaveBeenCalledOnce();
    expect(stopCore).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledWith("core-engine", stopError);
  });
});
