import { describe, expect, it, vi } from "vitest";
import {
  LinuxCgroupV2Supervisor,
  type LinuxCgroupV2Broker,
  type LinuxCgroupV2BrokerHandle
} from "../../src/core/linux-cgroup-v2-supervisor.js";
import type { ContainedRunnerLaunchOptions } from "../../src/core/process-tree-supervisor.js";

function makeHandle(
  overrides: Partial<LinuxCgroupV2BrokerHandle> = {}
): LinuxCgroupV2BrokerHandle & {
  calls: string[];
  setEmptyFailure(error: Error | undefined): void;
} {
  const calls: string[] = [];
  let emptyFailure: Error | undefined;
  const handle: LinuxCgroupV2BrokerHandle & {
    calls: string[];
    setEmptyFailure(error: Error | undefined): void;
  } = {
    protocolVersion: 1,
    containmentEstablished: true,
    evaluatorNotLoaded: true,
    containmentId: "test-boundary",
    calls,
    setEmptyFailure(error) { emptyFailure = error; },
    send: vi.fn(() => true),
    onMessage: vi.fn(() => () => undefined),
    onError: vi.fn(() => () => undefined),
    onRunnerExit: vi.fn(() => () => undefined),
    terminateBoundary: vi.fn(async () => { calls.push("terminate"); }),
    waitForBoundaryEmpty: vi.fn(async () => {
      calls.push("wait-empty");
      if (emptyFailure) throw emptyFailure;
    }),
    releaseBoundary: vi.fn(async () => { calls.push("release"); }),
    ...overrides
  };
  return handle;
}

const launchOptions: ContainedRunnerLaunchOptions = {
  runnerPath: "/trusted/policy-evaluator-child.js",
  execArgv: [],
  cwd: "/srv/infinyx",
  env: { NODE_ENV: "production" }
};

function brokerFor(handle: LinuxCgroupV2BrokerHandle): LinuxCgroupV2Broker {
  return { launchTrustedRunner: vi.fn(async () => handle) };
}

describe("LinuxCgroupV2Supervisor", () => {
  it("does not release the boundary until empty-state verification succeeds", async () => {
    const brokerHandle = makeHandle();
    const supervisor = new LinuxCgroupV2Supervisor(brokerFor(brokerHandle));
    const handle = await supervisor.launchContainedRunner(launchOptions);

    await expect(handle.dispose()).rejects.toThrow(/before boundary emptiness/i);
    expect(brokerHandle.releaseBoundary).not.toHaveBeenCalled();

    await handle.terminateTree();
    expect(brokerHandle.calls).toEqual(["terminate"]);

    await handle.waitForTreeExit();
    await handle.dispose();
    expect(brokerHandle.calls).toEqual(["terminate", "wait-empty", "release"]);
  });

  it("keeps the boundary allocated when empty-state verification fails", async () => {
    const brokerHandle = makeHandle();
    brokerHandle.setEmptyFailure(new Error("broker status unavailable"));
    const handle = await new LinuxCgroupV2Supervisor(brokerFor(brokerHandle))
      .launchContainedRunner(launchOptions);

    await handle.terminateTree();
    await expect(handle.waitForTreeExit()).rejects.toThrow("broker status unavailable");
    await expect(handle.dispose()).rejects.toThrow(/before boundary emptiness/i);
    expect(brokerHandle.releaseBoundary).not.toHaveBeenCalled();
  });

  it("blocks further IPC after verified empty state and after disposal", async () => {
    const brokerHandle = makeHandle();
    const handle = await new LinuxCgroupV2Supervisor(brokerFor(brokerHandle))
      .launchContainedRunner(launchOptions);

    expect(handle.send({ type: "evaluate" })).toBe(true);
    await handle.waitForTreeExit();
    expect(handle.send({ type: "late-message" })).toBe(false);
    await handle.dispose();
    expect(handle.send({ type: "after-dispose" })).toBe(false);
    expect(brokerHandle.send).toHaveBeenCalledTimes(1);
  });

  it("does not report successful tree exit when broker verification rejects", async () => {
    const brokerHandle = makeHandle();
    brokerHandle.setEmptyFailure(new Error("not empty"));
    const handle = await new LinuxCgroupV2Supervisor(brokerFor(brokerHandle))
      .launchContainedRunner(launchOptions);

    await expect(handle.waitForTreeExit()).rejects.toThrow("not empty");
    await expect(handle.dispose()).rejects.toThrow(/before boundary emptiness/i);
    expect(brokerHandle.releaseBoundary).not.toHaveBeenCalled();
  });

  it("terminates and verifies an invalid launch attestation before rejecting", async () => {
    const brokerHandle = makeHandle({ containmentEstablished: false as true });
    const handleBroker = brokerFor(brokerHandle);
    const supervisor = new LinuxCgroupV2Supervisor(handleBroker);

    await expect(supervisor.launchContainedRunner(launchOptions))
      .rejects.toThrow(/invalid launch attestation/i);
    expect(brokerHandle.calls).toEqual(["terminate", "wait-empty", "release"]);
  });

  it("does not release an invalidly attested boundary if empty verification fails", async () => {
    const brokerHandle = makeHandle({ evaluatorNotLoaded: false as true });
    brokerHandle.setEmptyFailure(new Error("cannot verify empty"));
    const supervisor = new LinuxCgroupV2Supervisor(brokerFor(brokerHandle));

    await expect(supervisor.launchContainedRunner(launchOptions))
      .rejects.toThrow("cannot verify empty");
    expect(brokerHandle.releaseBoundary).not.toHaveBeenCalled();
  });

  it("waits for an in-flight termination request before verifying boundary emptiness", async () => {
    let finishTermination: (() => void) | undefined;
    const brokerHandle = makeHandle({
      terminateBoundary: vi.fn(() => new Promise<void>((resolve) => {
        finishTermination = resolve;
      }))
    });
    const handle = await new LinuxCgroupV2Supervisor(brokerFor(brokerHandle))
      .launchContainedRunner(launchOptions);

    const terminating = handle.terminateTree();
    const waiting = handle.waitForTreeExit();
    await Promise.resolve();
    expect(brokerHandle.waitForBoundaryEmpty).not.toHaveBeenCalled();

    finishTermination?.();
    await Promise.all([terminating, waiting]);
    expect(brokerHandle.calls).toEqual(["wait-empty"]);
    expect(brokerHandle.waitForBoundaryEmpty).toHaveBeenCalledTimes(1);
  });

  it("does not race termination against an in-flight empty-state observation", async () => {
    let finishEmptyCheck: (() => void) | undefined;
    const brokerHandle = makeHandle({
      waitForBoundaryEmpty: vi.fn(() => new Promise<void>((resolve) => {
        finishEmptyCheck = resolve;
      }))
    });
    const handle = await new LinuxCgroupV2Supervisor(brokerFor(brokerHandle))
      .launchContainedRunner(launchOptions);

    const waiting = handle.waitForTreeExit();
    const terminating = handle.terminateTree();
    await Promise.resolve();
    expect(brokerHandle.terminateBoundary).not.toHaveBeenCalled();

    finishEmptyCheck?.();
    await Promise.all([waiting, terminating]);
    expect(brokerHandle.terminateBoundary).not.toHaveBeenCalled();
    expect(brokerHandle.waitForBoundaryEmpty).toHaveBeenCalledTimes(1);
  });

  it("requests termination after an in-flight empty-state observation fails", async () => {
    let failEmptyCheck: ((error: Error) => void) | undefined;
    const brokerHandle = makeHandle({
      waitForBoundaryEmpty: vi.fn(() => new Promise<void>((_resolve, reject) => {
        failEmptyCheck = reject;
      }))
    });
    const handle = await new LinuxCgroupV2Supervisor(brokerFor(brokerHandle))
      .launchContainedRunner(launchOptions);

    const waiting = handle.waitForTreeExit();
    const terminating = handle.terminateTree();
    failEmptyCheck?.(new Error("empty check unavailable"));
    await expect(waiting).rejects.toThrow("empty check unavailable");
    await terminating;
    expect(brokerHandle.terminateBoundary).toHaveBeenCalledTimes(1);
  });

  it("does not verify emptiness after termination fails until termination is retried successfully", async () => {
    const terminate = vi.fn()
      .mockRejectedValueOnce(new Error("termination request failed"))
      .mockResolvedValueOnce(undefined);
    const brokerHandle = makeHandle({ terminateBoundary: terminate });
    const handle = await new LinuxCgroupV2Supervisor(brokerFor(brokerHandle))
      .launchContainedRunner(launchOptions);

    await expect(handle.terminateTree()).rejects.toThrow("termination request failed");
    await expect(handle.waitForTreeExit()).rejects.toThrow("termination request failed");
    expect(brokerHandle.waitForBoundaryEmpty).not.toHaveBeenCalled();

    await handle.terminateTree();
    await handle.waitForTreeExit();
    expect(terminate).toHaveBeenCalledTimes(2);
    expect(brokerHandle.waitForBoundaryEmpty).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent empty-state verification and release operations", async () => {
    const brokerHandle = makeHandle();
    const handle = await new LinuxCgroupV2Supervisor(brokerFor(brokerHandle))
      .launchContainedRunner(launchOptions);

    await Promise.all([
      handle.waitForTreeExit(),
      handle.waitForTreeExit(),
      handle.waitForTreeExit()
    ]);
    await Promise.all([handle.dispose(), handle.dispose(), handle.dispose()]);

    expect(brokerHandle.waitForBoundaryEmpty).toHaveBeenCalledTimes(1);
    expect(brokerHandle.releaseBoundary).toHaveBeenCalledTimes(1);
    expect(brokerHandle.calls).toEqual(["wait-empty", "release"]);
  });

  it("allows a safe retry when boundary release fails", async () => {
    const brokerHandle = makeHandle();
    const release = vi.fn()
      .mockRejectedValueOnce(new Error("temporary release failure"))
      .mockResolvedValueOnce(undefined);
    brokerHandle.releaseBoundary = release;
    const handle = await new LinuxCgroupV2Supervisor(brokerFor(brokerHandle))
      .launchContainedRunner(launchOptions);

    await handle.waitForTreeExit();
    await expect(handle.dispose()).rejects.toThrow("temporary release failure");
    expect(handle.send({ type: "after-release-failure" })).toBe(false);

    await handle.dispose();
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent termination requests", async () => {
    const brokerHandle = makeHandle();
    const handle = await new LinuxCgroupV2Supervisor(brokerFor(brokerHandle))
      .launchContainedRunner(launchOptions);

    await Promise.all([handle.terminateTree(), handle.terminateTree()]);
    expect(brokerHandle.terminateBoundary).toHaveBeenCalledTimes(1);
  });
  it("rejects malformed or unbounded containment identifiers and cleans up fail-closed", async () => {
    for (const containmentId of ["../outside", "id with spaces", "line\\nbreak", "x".repeat(129)]) {
      const brokerHandle = makeHandle({ containmentId });
      const supervisor = new LinuxCgroupV2Supervisor(brokerFor(brokerHandle));

      await expect(supervisor.launchContainedRunner(launchOptions))
        .rejects.toThrow(/invalid launch attestation/i);
      expect(brokerHandle.calls).toEqual(["terminate", "wait-empty", "release"]);
    }
  });

  it("suppresses late broker messages after empty verification and unsubscribes on release", async () => {
    const messageListeners: Array<(message: unknown) => void> = [];
    const unsubscribe = vi.fn();
    const brokerHandle = makeHandle({
      onMessage: vi.fn((listener: (message: unknown) => void) => {
        messageListeners.push(listener);
        return unsubscribe;
      })
    });
    const handle = await new LinuxCgroupV2Supervisor(brokerFor(brokerHandle))
      .launchContainedRunner(launchOptions);
    const received: unknown[] = [];

    handle.onMessage((message) => received.push(message));
    messageListeners[0]?.({ type: "before-empty" });
    expect(received).toEqual([{ type: "before-empty" }]);

    await handle.waitForTreeExit();
    messageListeners[0]?.({ type: "after-empty" });
    expect(received).toEqual([{ type: "before-empty" }]);

    await handle.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    messageListeners[0]?.({ type: "after-release" });
    expect(received).toEqual([{ type: "before-empty" }]);
  });

  it("does not deliver broker messages while boundary release is in progress", async () => {
    const messageListeners: Array<(message: unknown) => void> = [];
    let finishRelease: (() => void) | undefined;
    const brokerHandle = makeHandle({
      onMessage: vi.fn((listener: (message: unknown) => void) => {
        messageListeners.push(listener);
        return () => undefined;
      }),
      releaseBoundary: vi.fn(() => new Promise<void>((resolve) => {
        finishRelease = resolve;
      }))
    });
    const handle = await new LinuxCgroupV2Supervisor(brokerFor(brokerHandle))
      .launchContainedRunner(launchOptions);
    const received: unknown[] = [];
    handle.onMessage((message) => received.push(message));
    await handle.waitForTreeExit();

    const disposing = handle.dispose();
    messageListeners[0]?.({ type: "during-release" });
    expect(received).toEqual([]);
    finishRelease?.();
    await disposing;
  });

  it("does not register new message listeners after empty verification or during release", async () => {
    const onMessage = vi.fn(() => () => undefined);
    let finishRelease: (() => void) | undefined;
    const brokerHandle = makeHandle({
      onMessage,
      releaseBoundary: vi.fn(() => new Promise<void>((resolve) => {
        finishRelease = resolve;
      }))
    });
    const handle = await new LinuxCgroupV2Supervisor(brokerFor(brokerHandle))
      .launchContainedRunner(launchOptions);
    const listener = vi.fn();

    handle.onMessage(listener);
    expect(onMessage).toHaveBeenCalledTimes(1);
    await handle.waitForTreeExit();

    const afterEmptyUnsubscribe = handle.onMessage(listener);
    expect(onMessage).toHaveBeenCalledTimes(1);
    afterEmptyUnsubscribe();

    const disposing = handle.dispose();
    const duringReleaseUnsubscribe = handle.onMessage(listener);
    expect(onMessage).toHaveBeenCalledTimes(1);
    duringReleaseUnsubscribe();

    finishRelease?.();
    await disposing;
    const afterReleaseUnsubscribe = handle.onMessage(listener);
    expect(onMessage).toHaveBeenCalledTimes(1);
    afterReleaseUnsubscribe();
  });


  it("does not retry a successful boundary release when listener cleanup throws", async () => {
    const failedUnsubscribe = vi.fn(() => {
      throw new Error("listener cleanup failed");
    });
    const successfulUnsubscribe = vi.fn();
    const brokerHandle = makeHandle({
      onMessage: vi.fn(() => failedUnsubscribe),
      onError: vi.fn(() => successfulUnsubscribe)
    });
    const handle = await new LinuxCgroupV2Supervisor(brokerFor(brokerHandle))
      .launchContainedRunner(launchOptions);

    handle.onMessage(() => undefined);
    handle.onError(() => undefined);
    await handle.waitForTreeExit();

    await expect(handle.dispose()).rejects.toThrow(/boundary was released/i);
    expect(brokerHandle.releaseBoundary).toHaveBeenCalledTimes(1);
    expect(failedUnsubscribe).toHaveBeenCalledTimes(1);
    expect(successfulUnsubscribe).toHaveBeenCalledTimes(1);
    expect(handle.send({ type: "after-release" })).toBe(false);

    await handle.dispose();
    expect(brokerHandle.releaseBoundary).toHaveBeenCalledTimes(1);
  });


  it("closes error and runner-exit subscriptions after empty verification and during release", async () => {
    const errorListeners: Array<(error: unknown) => void> = [];
    const exitListeners: Array<(exit: { readonly code: number | null; readonly signal: string | null }) => void> = [];
    let finishRelease: (() => void) | undefined;
    const onError = vi.fn((listener: (error: unknown) => void) => {
      errorListeners.push(listener);
      return () => undefined;
    });
    const onRunnerExit = vi.fn((listener: (exit: { readonly code: number | null; readonly signal: string | null }) => void) => {
      exitListeners.push(listener);
      return () => undefined;
    });
    const brokerHandle = makeHandle({
      onError,
      onRunnerExit,
      releaseBoundary: vi.fn(() => new Promise<void>((resolve) => {
        finishRelease = resolve;
      }))
    });
    const handle = await new LinuxCgroupV2Supervisor(brokerFor(brokerHandle))
      .launchContainedRunner(launchOptions);
    const receivedErrors: unknown[] = [];
    const receivedExits: unknown[] = [];

    handle.onError((error) => receivedErrors.push(error));
    handle.onRunnerExit((exit) => receivedExits.push(exit));
    errorListeners[0]?.(new Error("before-empty"));
    exitListeners[0]?.({ code: 1, signal: null });
    expect(receivedErrors).toHaveLength(1);
    expect(receivedExits).toHaveLength(1);

    await handle.waitForTreeExit();
    errorListeners[0]?.(new Error("after-empty"));
    exitListeners[0]?.({ code: 2, signal: null });
    handle.onError((error) => receivedErrors.push(error));
    handle.onRunnerExit((exit) => receivedExits.push(exit));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onRunnerExit).toHaveBeenCalledTimes(1);
    expect(receivedErrors).toHaveLength(1);
    expect(receivedExits).toHaveLength(1);

    const disposing = handle.dispose();
    errorListeners[0]?.(new Error("during-release"));
    exitListeners[0]?.({ code: 3, signal: null });
    handle.onError((error) => receivedErrors.push(error));
    handle.onRunnerExit((exit) => receivedExits.push(exit));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onRunnerExit).toHaveBeenCalledTimes(1);
    expect(receivedErrors).toHaveLength(1);
    expect(receivedExits).toHaveLength(1);

    finishRelease?.();
    await disposing;
  });

  it("does not verify or release an invalidly attested boundary when termination fails", async () => {
    const brokerHandle = makeHandle({
      containmentEstablished: false as true,
      terminateBoundary: vi.fn(async () => {
        throw new Error("termination unavailable");
      })
    });
    const supervisor = new LinuxCgroupV2Supervisor(brokerFor(brokerHandle));

    await expect(supervisor.launchContainedRunner(launchOptions))
      .rejects.toThrow("termination unavailable");
    expect(brokerHandle.waitForBoundaryEmpty).not.toHaveBeenCalled();
    expect(brokerHandle.releaseBoundary).not.toHaveBeenCalled();
  });

});
  it("propagates an atomic broker subscription failure without tracking a phantom listener", async () => {
    const listener = vi.fn();
    const unsubscribe = vi.fn();
    const onMessage = vi.fn()
      .mockImplementationOnce(() => {
        // Atomic broker contract: throwing means no registration was installed.
        throw new Error("subscription unavailable");
      })
      .mockImplementationOnce(() => unsubscribe);
    const brokerHandle = makeHandle({ onMessage });
    const handle = await new LinuxCgroupV2Supervisor(brokerFor(brokerHandle))
      .launchContainedRunner(launchOptions);

    expect(() => handle.onMessage(listener)).toThrow("subscription unavailable");
    expect(() => handle.onMessage(listener)).not.toThrow();
    await handle.waitForTreeExit();
    await handle.dispose();

    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

