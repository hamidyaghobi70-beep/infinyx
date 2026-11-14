export type CoreErrorCode =
  | "INVALID_MODULE"
  | "DUPLICATE_MODULE"
  | "UNKNOWN_DEPENDENCY"
  | "MODULE_DEPENDENCY_CYCLE"
  | "INVALID_LIFECYCLE_TRANSITION"
  | "MODULE_INITIALIZATION_FAILED"
  | "MODULE_START_FAILED"
  | "MODULE_STOP_FAILED"
  | "PROTECTED_OPERATION_DRAIN_TIMEOUT"
  | "PROTECTED_OPERATION_SHUTDOWN_FAILED"
  | "PROTECTED_OPERATION_SHUTDOWN_CONFIG_INVALID"
  | "POLICY_EVALUATION_DRAIN_TIMEOUT"
  | "POLICY_SHUTDOWN_FAILED"
  | "MODULE_DEPENDENCY_CLEANUP_BLOCKED"
  | "INVALID_MEMORY_CAPABILITY";

export type CoreShutdownBlockerCode =
  | "PROTECTED_OPERATION_SHUTDOWN_FAILED"
  | "POLICY_SHUTDOWN_FAILED"
  | "PROTECTED_OPERATION_DRAIN_TIMEOUT"
  | "POLICY_EVALUATION_DRAIN_TIMEOUT";

export interface CoreShutdownBlocker {
  readonly code: CoreShutdownBlockerCode;
  readonly subsystem: "protected_operations" | "policy";
  readonly state: "failed" | "unresolved";
}

export class CoreError extends Error {
  readonly shutdownBlockers?: readonly CoreShutdownBlocker[];

  constructor(
    public readonly code: CoreErrorCode,
    message: string,
    options?: ErrorOptions,
    shutdownBlockers?: readonly CoreShutdownBlocker[]
  ) {
    super(message, options);
    this.name = "CoreError";
    if (shutdownBlockers !== undefined) {
      this.shutdownBlockers = Object.freeze(shutdownBlockers.map((blocker) =>
        Object.freeze({
          code: blocker.code,
          subsystem: blocker.subsystem,
          state: blocker.state
        })
      ));
    }
  }
}
