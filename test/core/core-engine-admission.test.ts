import { describe, expect, it, vi } from "vitest";
import { CoreEngine } from "../../src/core/core-engine.js";
import type { MemoryAddress, ModuleContext } from "../../src/core/contracts.js";

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const address: MemoryAddress = { namespace: "test", key: "record" };

describe("CoreEngine operation admission and drain", () => {
  it("gates public and injected service ports while allowing children of admitted work", async () => {
    const handlerEntered = deferred();
    const finishHandler = deferred();
    const policy = { evaluate: vi.fn(async () => ({ effect: "deny" as const, reason: "test" })) };
    const memory = {
      read: vi.fn(async () => ({ value: 1 })),
      write: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined)
    };
    let context!: ModuleContext;
    const engine = new CoreEngine({
      policy,
      memory,
      operationDrainTimeoutMs: 1_000
    });
    engine.register({
      id: "worker",
      version: "1.0.0",
      initialize: (moduleContext) => {
        context = moduleContext;
        moduleContext.events.subscribe("work", async () => {
          handlerEntered.resolve();
          await finishHandler.promise;
          await moduleContext.policy.evaluate({
            actorId: "worker",
            action: "nested",
            resource: "test"
          });
          await moduleContext.memory?.read(address);
        });
      },
      stop: async (moduleContext) => {
        // Cleanup receives a privileged tracked root and may use its child ports.
        await moduleContext.policy.evaluate({
          actorId: "worker",
          action: "cleanup",
          resource: "test"
        });
      }
    });

    await engine.initialize();
    const publishing = engine.events.publish("work", {});
    await handlerEntered.promise;
    engine.requestClose();

    await expect(engine.events.publish("late", {})).rejects.toMatchObject({
      code: "OPERATION_ADMISSION_CLOSED"
    });
    await expect(engine.policy.evaluate({
      actorId: "external",
      action: "late",
      resource: "test"
    })).rejects.toMatchObject({ code: "OPERATION_ADMISSION_CLOSED" });
    await expect(context.memory?.read(address)).rejects.toMatchObject({
      code: "OPERATION_ADMISSION_CLOSED"
    });

    const stopping = engine.stop();
    let stopped = false;
    void stopping.then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);

    finishHandler.resolve();
    await publishing;
    await stopping;

    expect(policy.evaluate).toHaveBeenCalledTimes(2);
    expect(memory.read).toHaveBeenCalledOnce();
    expect(engine.state).toBe("stopped");
    expect(engine.activeOperationCount).toBe(0);
    expect(engine.activePromiseCount).toBe(0);
  });

  it("records drain_timeout, preserves live handles, and allows a safe retry after settlement", async () => {
    const entered = deferred();
    const finish = deferred();
    const engine = new CoreEngine({ operationDrainTimeoutMs: 5 });
    engine.register({
      id: "worker",
      version: "1.0.0",
      initialize: (context) => {
        context.events.subscribe("slow", async () => {
          entered.resolve();
          await finish.promise;
        });
      }
    });

    await engine.initialize();
    const publishing = engine.events.publish("slow", {});
    await entered.promise;
    engine.requestClose();

    await expect(engine.stop()).rejects.toMatchObject({
      code: "OPERATION_DRAIN_TIMEOUT"
    });
    expect(engine.state).toBe("failed");
    expect(engine.failureReason).toBe("drain_timeout");
    expect(engine.activeOperationCount).toBeGreaterThan(0);

    finish.resolve();
    await publishing;
    await engine.stop();
    expect(engine.state).toBe("stopped");
    expect(engine.failureReason).toBeUndefined();
  });

  it("rejects a shutdown initiated by an operation that would otherwise wait for itself", async () => {
    const engine = new CoreEngine();
    engine.register({
      id: "worker",
      version: "1.0.0",
      initialize: (context) => {
        context.events.subscribe("stop-inside-operation", async () => {
          await expect(engine.stop()).rejects.toMatchObject({
            code: "OPERATION_DRAIN_SELF_WAIT"
          });
        });
      }
    });

    await engine.initialize();
    await engine.events.publish("stop-inside-operation", {});
    expect(engine.state).toBe("failed");

    await engine.stop();
    expect(engine.state).toBe("stopped");
  });

  it("tracks operations started by module lifecycle hooks and blocks detached work after settlement", async () => {
    const detachedResult = deferred<string>();
    const engine = new CoreEngine();
    engine.register({
      id: "worker",
      version: "1.0.0",
      initialize: async (context) => {
        context.events.subscribe("noop", () => undefined);
        setImmediate(() => {
          void context.policy.evaluate({
            actorId: "worker",
            action: "detached",
            resource: "test"
          }).then(
            () => detachedResult.resolve("accepted"),
            (error: unknown) => detachedResult.resolve(
              error instanceof Error && "code" in error ? String(error.code) : "unexpected"
            )
          );
        });
      }
    });

    await engine.initialize();
    engine.requestClose();
    await engine.stop();
    expect(await detachedResult.promise).toBe("OPERATION_PARENT_SETTLED");
  });
});
