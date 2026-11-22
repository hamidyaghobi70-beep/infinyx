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
 * and independent empty-state verification. Event subscription methods must
 * be atomic: if registration throws, no listener may remain installed; a
 * successful registration returns an idempotent unsubscriber for that exact
 * listener. This interface is not itself an OS containment mechanism.
 */
export interface LinuxCgroupV2BrokerHandle {
  readonly protocolVersion: 1;
  /** True only after runner membership and readiness have both been verified. */
  readonly containmentEstablished: true;
  /** True only while evaluator code has not yet been imported/executed. */
  readonly evaluatorNotLoaded: true;
  readonly containmentId: string;

  send(message: Readonly<Record<string, unknown>>): boolean;
  /**
   * Subscription registration must be atomic: either install the listener and
   * return its unsubscriber, or throw without retaining any listener. The
   * returned unsubscriber must be safe to call at most once and must detach
   * only this registration.
   */
  onMessage(listener: (message: unknown) => void): () => void;
  /** Same atomic registration and per-listener cleanup contract as onMessage. */
  onError(listener: (error: unknown) => void): () => void;
  /** Same atomic registration and per-listener cleanup contract as onMessage. */
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
 *
 * Failure ownership is part of the broker contract: if launch rejects after
 * allocating any process or boundary resources, the broker must retain
 * ownership and perform fail-closed cleanup only after independently proving
 * the boundary empty, or retain the allocation in an operator-recoverable
 * state. It must never orphan a partially-created boundary. The same ownership
 * rule applies when later termination, empty verification, or release calls
 * fail; an adapter error is not permission to abandon the allocation.
 */
export interface LinuxCgroupV2Broker {
  launchTrustedRunner(
    options: ContainedRunnerLaunchOptions
  ): Promise<LinuxCgroupV2BrokerHandle>;
}

function isValidContainmentId(value: unknown): value is string {
  // Opaque IDs may be logged or correlated by callers; reject control chars,
  // whitespace, path separators, and unbounded broker-controlled values.
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
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
      !isValidContainmentId(handle.containmentId)
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
    let releasing = false;
    let terminationPromise: Promise<void> | undefined;
    let terminationFailed = false;
    let terminationFailure: unknown;
    let emptyVerificationPromise: Promise<void> | undefined;
    let releasePromise: Promise<void> | undefined;
    const unsubscribeAll = new Set<() => void>();

    const subscribe = <T>(
      register: (callback: (value: T) => void) => () => void,
      listener: (value: T) => void,
      shouldDeliver: () => boolean
    ): (() => void) => {
      if (disposed) return () => undefined;
      let active = true;
      const unsubscribe = register((value) => {
        if (active && shouldDeliver()) listener(value);
      });
      const cleanup = (): void => {
        if (!active) return;
        active = false;
        try {
          unsubscribe();
        } finally {
          unsubscribeAll.delete(cleanup);
        }
      };
      unsubscribeAll.add(cleanup);
      return cleanup;
    };

    return {
      containmentId: handle.containmentId,
      send: (message) => !disposed && !releasing && !emptyVerified && handle.send(message),
      onMessage: (listener) => {
        // Do not create broker subscriptions once message delivery is permanently closed.
        if (releasing || emptyVerified || disposed) return () => undefined;
        return subscribe(
          (callback) => handle.onMessage(callback),
          listener,
          () => !releasing && !emptyVerified && !disposed
        );
      },
      onError: (listener) => {
        // All broker event channels close once emptiness is verified or release starts.
        if (releasing || emptyVerified || disposed) return () => undefined;
        return subscribe(
          (callback) => handle.onError(callback),
          listener,
          () => !releasing && !emptyVerified && !disposed
        );
      },
      onRunnerExit: (listener) => {
        if (releasing || emptyVerified || disposed) return () => undefined;
        return subscribe(
          (callback) => handle.onRunnerExit(callback),
          listener,
          () => !releasing && !emptyVerified && !disposed
        );
      },
      terminateTree: async () => {
        if (disposed || releasing || emptyVerified) return;
        // Do not race a termination request against an already-running
        // emptiness observation. If that observation fails, termination may
        // proceed; if it succeeds, the boundary is already empty.
        if (emptyVerificationPromise) {
          try {
            await emptyVerificationPromise;
          } catch {
            // A failed observation is not proof of emptiness; request termination below.
          }
          if (emptyVerified || disposed || releasing) return;
        }
        if (!terminationPromise) {
          terminationPromise = handle.terminateBoundary().then(() => {
            terminationFailed = false;
            terminationFailure = undefined;
          }).catch((error: unknown) => {
            terminationPromise = undefined;
            terminationFailed = true;
            terminationFailure = error;
            throw error;
          });
        }
        await terminationPromise;
      },
      waitForTreeExit: async () => {
        if (disposed || releasing) {
          if (emptyVerified) return;
          throw new Error("Containment boundary is being released without verified emptiness.");
        }
        if (emptyVerified) return;
        if (!emptyVerificationPromise) {
          emptyVerificationPromise = (async () => {
            // If termination has already been requested, do not verify emptiness
            // or permit release until that request has settled successfully.
            if (terminationFailed) throw terminationFailure;
            if (terminationPromise) await terminationPromise;
            await handle.waitForBoundaryEmpty();
            emptyVerified = true;
          })().catch((error: unknown) => {
            // Permit a later independent verification attempt after transient broker failure.
            emptyVerificationPromise = undefined;
            throw error;
          });
        }
        await emptyVerificationPromise;
      },
      dispose: async () => {
        if (disposed) return;
        if (!emptyVerified) {
          throw new Error("Cannot release Linux containment before boundary emptiness is verified.");
        }
        if (!releasePromise) {
          releasing = true;
          releasePromise = handle.releaseBoundary().then(() => {
            // The OS boundary is now released. Never retry releaseBoundary
            // merely because a local event-listener cleanup reports an error.
            disposed = true;
            const cleanupErrors: unknown[] = [];
            for (const unsubscribe of [...unsubscribeAll]) {
              try {
                unsubscribe();
              } catch (error) {
                cleanupErrors.push(error);
              }
            }
            if (cleanupErrors.length > 0) {
              throw new Error(
                `Containment was released, but ${cleanupErrors.length} broker listener cleanup operation(s) failed.`
              );
            }
          }).catch((error: unknown) => {
            // A cleanup failure after successful release must not reopen lifecycle state.
            if (!disposed) {
              releasing = false;
              releasePromise = undefined;
            }
            throw error;
          });
        }
        await releasePromise;
      }
    };
  }
}
