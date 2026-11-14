import type { Readable } from "node:stream";

export type PolicyOutputFailureReason =
  | "OUTPUT_LIMIT_EXCEEDED"
  | "OUTPUT_STREAM_FAILED";

/**
 * Observe a child output stream without retaining its contents.
 * Stream failures are converted into a fixed internal failure reason.
 */
export function observePolicyOutputStream(
  stream: Readable | null | undefined,
  onChunk: (chunk: unknown) => void,
  onFailure: (reason: PolicyOutputFailureReason) => void
): void {
  if (!stream) return;
  stream.on("data", onChunk);
  stream.on("error", () => onFailure("OUTPUT_STREAM_FAILED"));
}
