/**
 * Trust boundary for OS-level process-tree containment.
 *
 * This is a contract only. It deliberately has no Node.js child_process
 * fallback and no implementation that can claim containment without an
 * independently verified OS boundary.
 */

/** Configuration for the trusted bootstrap process; evaluator code is not loaded here. */
export interface ContainedRunnerLaunchOptions {
  /** Absolute path to the trusted runner/bootstrap artifact. */
  readonly runnerPath: string;
  /** Runtime flags for the trusted runner only. */
  readonly execArgv: readonly string[];
  /** Working directory for the trusted runner. */
  readonly cwd: string;
  /** Explicit environment allowlist prepared by the trusted composition root. */
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Handle returned only after the supervisor has verified that the trusted
 * runner is inside its protected boundary and is ready to receive IPC.
 * Implementations must not expose evaluator-controlled code before this point.
 */
export interface ContainedProcessHandle {
  /** Opaque supervisor-owned identifier; not a filesystem path or cgroup name. */
  readonly containmentId: string;

  /** Send a parent-to-runner IPC message. Returns false if the channel is unavailable. */
  send(message: Readonly<Record<string, unknown>>): boolean;

  /** Subscribe to untrusted runner IPC. Callers must authenticate every message. */
  onMessage(listener: (message: unknown) => void): () => void;

  /** Subscribe to control-channel or runner errors. */
  onError(listener: (error: unknown) => void): () => void;

  /**
   * Diagnostic notification only. Direct-runner exit MUST NOT be treated as
   * proof that the complete containment boundary is empty.
   */
  onRunnerExit(listener: (exit: { readonly code: number | null; readonly signal: string | null }) => void): () => void;

  /**
   * Requests termination of the complete OS containment boundary.
   * Resolution means only that the request was issued, never that it succeeded.
   */
  terminateTree(): Promise<void>;

  /**
   * Resolves only after the supervisor independently verifies that the entire
   * boundary is empty. If terminateTree() is already in flight, verification
   * must not complete until that termination request has settled successfully.
   * Implementations must also serialize a new termination request against an
   * in-flight emptiness observation: successful emptiness proof wins; if the
   * observation fails, termination may then be requested.
   * Rejects if termination or emptiness verification cannot be established.
   */
  waitForTreeExit(): Promise<void>;

  /**
   * Releases boundary resources. MUST reject unless waitForTreeExit has
   * completed successfully; implementations must not offer a force-release.
   */
  dispose(): Promise<void>;
}

/**
 * Platform-specific supervisor for trusted runner processes.
 *
 * A Linux implementation must use a protected cgroup v2 boundary and enforce
 * delegation permissions against the actual evaluator identity. Unsupported
 * platforms must reject launch; they must never silently downgrade to fork(),
 * child.kill(), or process-group signaling.
 */
export interface ProcessTreeSupervisor {
  /**
   * Launches only the trusted bootstrap. The promise resolves after the
   * supervisor verifies containment membership and runner readiness, before
   * the caller can send the evaluator's authenticated evaluate message.
   */
  launchContainedRunner(options: ContainedRunnerLaunchOptions): Promise<ContainedProcessHandle>;
}
