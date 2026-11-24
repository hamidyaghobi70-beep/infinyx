export type CoreErrorCode =
  | "INVALID_MODULE"
  | "DUPLICATE_MODULE"
  | "UNKNOWN_DEPENDENCY"
  | "MODULE_DEPENDENCY_CYCLE"
  | "INVALID_LIFECYCLE_TRANSITION"
  | "MODULE_INITIALIZATION_FAILED"
  | "MODULE_START_FAILED"
  | "MODULE_STOP_FAILED"
  | "OPERATION_ADMISSION_CLOSED"
  | "OPERATION_PARENT_SETTLED"
  | "OPERATION_HANDLE_ALREADY_RELEASED"
  | "OPERATION_COUNTER_UNDERFLOW"
  | "OPERATION_DRAIN_TIMEOUT"
  | "OPERATION_DRAIN_SELF_WAIT";

export class CoreError extends Error {
  constructor(
    public readonly code: CoreErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "CoreError";
  }
}
