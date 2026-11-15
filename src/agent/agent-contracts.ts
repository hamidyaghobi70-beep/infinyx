export type AgentTaskStatus =
  | "running"
  | "completed"
  | "cancelled"
  | "timed_out"
  | "rejected"
  | "error";

/**
 * Describes the runtime's tracking state, not merely the caller-visible result.
 *
 * - "running": the provider promise is pending and no early cancellation or
 *   timeout result has been returned.
 * - "unresolved": cancellation or timeout has been returned to the caller,
 *   but the provider promise is still pending and continues to hold capacity.
 * - "settled": the provider promise has settled, or provider invocation was
 *   skipped because cancellation/shutdown won before the provider microtask.
 *
 * "settled" therefore does not by itself prove that a provider call began.
 */
export type AgentExecutionState = "running" | "unresolved" | "settled";

export interface AgentTaskRequest {
  readonly taskId: string;
  readonly prompt: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface AgentTaskRecord {
  readonly taskId: string;
  readonly status: AgentTaskStatus;
  readonly executionState: AgentExecutionState;
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly reason?: string;
}

export type AgentTaskResult =
  | { readonly status: "completed"; readonly taskId: string; readonly output: string }
  | { readonly status: "cancelled"; readonly taskId: string; readonly executionState: AgentExecutionState }
  | { readonly status: "timed_out"; readonly taskId: string; readonly executionState: AgentExecutionState }
  | { readonly status: "rejected"; readonly taskId: string; readonly reason: string; readonly code?: "CAPACITY_EXCEEDED" }
  | { readonly status: "error"; readonly taskId: string; readonly code: string };

export interface AgentRuntimeOptions {
  readonly defaultTimeoutMs?: number;
  readonly maxPromptLength?: number;
  readonly maxOutputLength?: number;
}

export const AGENT_MODULE_ID = "agent";
export const AGENT_MODULE_VERSION = "1.0.0";
export const DEFAULT_AGENT_TIMEOUT_MS = 30_000;
export const MAX_AGENT_TIMEOUT_MS = 120_000;
export const MAX_AGENT_PROMPT_LENGTH = 8_000;
export const MAX_AGENT_OUTPUT_LENGTH = 16_000;
export const MAX_TRACKED_TASKS = 256;
/** Maximum number of tasks admitted concurrently, including unresolved cancellations. */
export const MAX_ACTIVE_TASKS = 32;
