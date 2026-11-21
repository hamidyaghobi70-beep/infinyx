import type {
  ContainedProcessHandle,
  ContainedRunnerLaunchOptions,
  ProcessTreeSupervisor
} from "./process-tree-supervisor.js";

/**
 * Trusted broker boundary for Linux cgroup v2 operations.
 *
 * The broker implementation must run outside the evaluator's authority and
 * enforce cgroup ownership, migration restrictions, tree-wide termination,
 * and independent empty-state verification. This interface is not itself an
 * OS containment mechanism.
 */
export interface LinuxCgroupV2BrokerHandle {
  readonly protocolVersion: 1;
  /** True only after runner membership and readiness have both been verified. */
  readonly containmentEstablished: true;
  /** True only while evaluator code has not yet been imported/executed. */
  readonly evaluatorNotLoaded: true;
  readonly containmentId: string;

  send(message: Readonly<Record<string, unknown>>): boolean;
  onMessage(listener: (message: unknown) => void): () => void;
  onError(listener: (error: unknown) => void): () => void;
  onRunnerExit(
    listener: (exit: { readonly code: number | null; readonly signal: string | null }) => void
  ): () => void;
  terminateBoundary(): Promise<void>;
  waitForBoundaryEmpty(): Promise<void>;
  releaseBoundary(): Promise<void>;
}

/**
 * Implemented by a separately trusted, narrowly privileged service.
 * It must spawn only the supplied trusted bootstrap and put it inside the
 * supervisor-owned cgroup boundary before resolving.
 */
export interface LinuxCgroupV2Broker {
  launchTrustedRunner(
    options: ContainedRunnerLaunchOptions
  ): Promise<LinuxCgroupV2BrokerHandle>;
}

/**
 * Adapts a trusted broker to the platform-neutral supervisor contract.
 *
 * This class intentionally contains no cgroup filesystem writes and no
 * child_process fallback. It is safe to use only with a broker whose process
 * identity, socket access, cgroup permissions, and kernel behavior have been
 * independently reviewed and integration-tested.
 */
export class LinuxCgroupV2Supervisor implements ProcessTreeSupervisor {
  constructor(private readonly broker: LinuxCgroupV2Broker) {}

  async launchContainedRunner(
    options: ContainedRunnerLaunchOptions
  ): Promise<ContainedProcessHandle> {
    const handle = await this.broker.launchTrustedRunner(options);

    if (
      handle.protocolVersion !== 1 ||
      handle.containmentEstablished !== true ||
      handle.evaluatorNotLoaded !== true ||
      typeof handle.containmentId !== "string" ||
      handle.containmentId.length === 0
    ) {
      // A failed attestation is not permission to release resources. Attempt
      // boundary termination and require independent emptiness proof first.
      await handle.terminateBoundary();
      await handle.waitForBoundaryEmpty();
      await handle.releaseBoundary();
      throw new Error("Linux containment broker returned an invalid launch attestation.");
    }

    let emptyVerified = false;
    let disposed = false;

    return {
      containmentId: handle.containmentId,
      send: (message) => !disposed && !emptyVerified && handle.send(message),
      onMessage: (listener) => handle.onMessage(listener),
      onError: (listener) => handle.onError(listener),
      onRunnerExit: (listener) => handle.onRunnerExit(listener),
      terminateTree: async () => {
        if (disposed || emptyVerified) return;
        await handle.terminateBoundary();
      },
      waitForTreeExit: async () => {
        if (disposed) throw new Error("Containment boundary has already been released.");
        if (emptyVerified) return;
        await handle.waitForBoundaryEmpty();
        emptyVerified = true;
      },
      dispose: async () => {
        if (disposed) return;
        if (!emptyVerified) {
          throw new Error("Cannot release Linux containment before boundary emptiness is verified.");
        }
        await handle.releaseBoundary();
        disposed = true;
      }
    };
  }
}
