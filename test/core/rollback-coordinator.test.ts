import { describe, expect, it } from "vitest";
import { RollbackCoordinator } from "../../src/core/rollback-coordinator.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("RollbackCoordinator", () => {
  it("shares one in-flight promise and prevents concurrent rollback execution", async () => {
    const coordinator = new RollbackCoordinator();
    const gate = deferred();
    let calls = 0;
    const operation = async (): Promise<void> => {
      calls += 1;
      await gate.promise;
    };

    const first = coordinator.run(operation);
    const second = coordinator.run(operation);
    expect(first).toBe(second);
    expect(coordinator.isRunning).toBe(true);
    expect(calls).toBe(0);

    gate.resolve();
    await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(coordinator.isRunning).toBe(false);
  });

  it("preserves the original rejection and permits a later retry", async () => {
    const coordinator = new RollbackCoordinator();
    const failure = new Error("rollback cleanup failed");

    await expect(coordinator.run(async () => { throw failure; })).rejects.toBe(failure);
    expect(coordinator.isRunning).toBe(false);

    await coordinator.run(async () => undefined);
    expect(coordinator.isRunning).toBe(false);
  });
});
