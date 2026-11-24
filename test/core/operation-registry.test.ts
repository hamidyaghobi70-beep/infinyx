import { describe, expect, it } from "vitest";
import { OperationRegistry } from "../../src/core/operation-registry.js";

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("OperationRegistry", () => {
  it("tracks multiple promises per handle and removes it only after that handle reaches zero", async () => {
    const registry = new OperationRegistry();
    const handle = registry.tryEnter();
    const first = deferred();
    const second = deferred();

    const firstTracked = handle.track(first.promise);
    const secondTracked = handle.track(second.promise);
    expect(handle.pendingPromiseCount).toBe(2);
    expect(registry.activePromiseCount).toBe(2);
    expect(registry.activeHandleCount).toBe(1);

    first.resolve();
    await firstTracked;
    expect(handle.pendingPromiseCount).toBe(1);
    expect(registry.activeHandleCount).toBe(1);

    second.resolve();
    await secondTracked;
    expect(handle.pendingPromiseCount).toBe(0);
    expect(registry.activePromiseCount).toBe(0);
    expect(registry.activeHandleCount).toBe(0);
  });

  it("releases an IDLE handle immediately and rejects subsequent tracking", async () => {
    const registry = new OperationRegistry();
    const handle = registry.tryEnter();
    expect(registry.activeHandleCount).toBe(1);

    handle.release();
    expect(handle.state).toBe("RELEASED_MANUAL");
    expect(registry.activeHandleCount).toBe(0);
    expect(() => handle.track(Promise.resolve())).toThrow(/no longer track promises/i);
  });

  it("does not remove a tracked handle on manual release until every promise settles", async () => {
    const registry = new OperationRegistry();
    const handle = registry.tryEnter();
    const gate = deferred();
    const tracked = handle.track(gate.promise);

    handle.release();
    expect(registry.activeHandleCount).toBe(1);
    expect(() => handle.track(Promise.resolve())).toThrow(/no longer track promises/i);

    gate.resolve();
    await tracked;
    expect(handle.state).toBe("RELEASED_MANUAL");
    expect(registry.activeHandleCount).toBe(0);
  });

  it("admits a child during drain while its parent is still registered, and drain waits for both", async () => {
    const registry = new OperationRegistry();
    const parentEntered = deferred();
    const allowChild = deferred();
    const childEntered = deferred();
    const finishChild = deferred();

    const parent = registry.run(async () => {
      parentEntered.resolve();
      await allowChild.promise;
      await registry.run(async () => {
        childEntered.resolve();
        await finishChild.promise;
      });
    });

    await parentEntered.promise;
    registry.closeAdmission();
    const drain = registry.drain(1_000);
    allowChild.resolve();
    await childEntered.promise;

    expect(registry.activeHandleCount).toBe(2);
    let drained = false;
    void drain.then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);

    finishChild.resolve();
    await parent;
    await drain;
    expect(registry.activeHandleCount).toBe(0);
    expect(registry.activePromiseCount).toBe(0);
  });

  it("rejects a child whose parent has already settled and never reports drain early", async () => {
    const registry = new OperationRegistry();
    const lateResult = deferred<string>();
    const parent = registry.run(async () => {
      setImmediate(() => {
        void registry.run(() => undefined).then(
          () => lateResult.resolve("accepted"),
          (error: unknown) => {
            lateResult.resolve(
              error instanceof Error && "code" in error
                ? String(error.code)
                : "unexpected-error"
            );
          }
        );
      });
    });

    registry.closeAdmission();
    const drain = registry.drain(1_000);
    await parent;
    expect(await lateResult.promise).toBe("OPERATION_PARENT_SETTLED");
    await drain;
    expect(registry.activeHandleCount).toBe(0);
  });

  it("rejects independent work after close and reports a drain timeout without dropping handles", async () => {
    const registry = new OperationRegistry();
    const gate = deferred();
    const active = registry.run(() => gate.promise);
    registry.closeAdmission();

    await expect(registry.run(() => undefined)).rejects.toMatchObject({
      code: "OPERATION_ADMISSION_CLOSED"
    });
    await expect(registry.drain(1)).rejects.toMatchObject({
      code: "OPERATION_DRAIN_TIMEOUT"
    });
    expect(registry.activeHandleCount).toBe(1);

    gate.resolve();
    await active;
    await registry.drain(1);
    expect(registry.activeHandleCount).toBe(0);
  });
});
