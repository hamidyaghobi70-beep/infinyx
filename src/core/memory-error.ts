export type MemoryErrorCode =
  | "MEMORY_INVALID_SCOPE"
  | "MEMORY_INVALID_ADDRESS"
  | "MEMORY_INVALID_VALUE"
  | "MEMORY_ACCESS_DENIED"
  | "MEMORY_AUDIT_UNAVAILABLE"
  | "MEMORY_BACKEND_FAILED";

/**
 * Error raised by the memory boundary. Messages are deliberately generic: policy
 * reasons, backend details and stored values are never included. Use `cause` and
 * the audit events for diagnostics.
 */
export class MemoryAccessError extends Error {
  constructor(
    public readonly code: MemoryErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "MemoryAccessError";
  }
}
