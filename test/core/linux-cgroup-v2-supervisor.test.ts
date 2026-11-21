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

});
