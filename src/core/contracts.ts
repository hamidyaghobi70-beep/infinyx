export type CoreLifecycleState =
  | "created"
  | "initializing"
  | "initialized"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed";

export type ModuleLifecycleState =
  | "registered"
  | "initializing"
  | "initialized"
  | "starting"
  | "running"
  | "cleaning"
  | "stopping"
  | "stopped"
  | "failed";

export interface EventEnvelope<TPayload = unknown> {
  readonly type: string;
  readonly payload: TPayload;
  readonly occurredAt: Date;
}

export type EventHandler<TPayload = unknown> = (
  event: EventEnvelope<TPayload>
) => void | Promise<void>;

export interface EventBusPort {
  subscribe<TPayload>(type: string, handler: EventHandler<TPayload>): () => void;
  publish<TPayload>(type: string, payload: TPayload): Promise<void>;
}

export interface MemoryAddress {
  readonly namespace: string;
  readonly key: string;
}

/**
 * Storage boundary only. No persistence adapter is provided by Core Engine v1.
 * Implementations must define encryption, retention, tenant isolation and access
 * control before they are connected to production workloads.
 */
export interface MemoryPort {
  read(address: MemoryAddress): Promise<unknown | null>;
  write(address: MemoryAddress, value: unknown): Promise<void>;
  delete(address: MemoryAddress): Promise<void>;
}

export interface PolicyContext {
  readonly attributes?: Readonly<Record<string, unknown>>;
}

export interface PolicyRequest {
  readonly actorId: string;
  readonly action: string;
  readonly resource: string;
  readonly context?: PolicyContext;
}

export interface PolicyDecision {
  readonly effect: "allow" | "deny";
  readonly reason: string;
}

export type PolicyExecutionLifecycleState =
  | "CREATED"
  | "AUTHORIZING"
  | "AUTHORIZED"
  | "RUNNING"
  | "STOP_REQUESTED"
  | "FINALIZING"
  | "TERMINAL"
  | "UNRESOLVED";

export type PolicyStopReason =
  | "CALLER_CANCELLED"
  | "POLICY_TIMEOUT"
  | "RUNTIME_SHUTDOWN"
  | "PARENT_CANCELLED";

export type PolicyTerminalOutcome =
  | "COMPLETED"
  | "CANCELLED"
  | "DENIED"
  | "TIMED_OUT"
  | "FAILED"
  | "UNRESOLVED";

export type PolicyCleanupStatus =
  | "NOT_REQUIRED"
  | "PENDING"
  | "COMPLETED"
  | "FAILED"
  | "UNRESOLVED";

export type PolicyRuntimeStatus =
  | "NOT_STARTED"
  | "RUNNING"
  | "STOP_REQUESTED"
  | "STOPPED"
  | "UNRESOLVED";

export interface PolicyExecutionRecord {
  readonly lifecycle: PolicyExecutionLifecycleState;
  readonly outcome: PolicyTerminalOutcome;
  readonly decision: PolicyDecision;
  readonly runtimeStatus: PolicyRuntimeStatus;
  readonly cleanupStatus: PolicyCleanupStatus;
  readonly stopReason?: PolicyStopReason;
  readonly candidateFrozen: true;
}

export interface PolicyCancellationCause {
  readonly code: PolicyStopReason;
  readonly message: string;
}

export interface PolicyEvaluationOptions {
  readonly signal?: AbortSignal;
  readonly parentSignal?: AbortSignal;
  readonly deadlineAt?: number;
}

export interface PolicyEngine {
  evaluate(request: PolicyRequest, options?: PolicyEvaluationOptions): Promise<PolicyDecision>;
}

export interface ModuleContext {
  readonly moduleId: string;
  readonly events: EventBusPort;
  readonly policy: PolicyEngine;
  readonly memory?: MemoryPort;
}

export interface CoreModule {
  readonly id: string;
  readonly version: string;
  readonly dependencies?: readonly string[];
  initialize?(context: ModuleContext): void | Promise<void>;
  start?(context: ModuleContext): void | Promise<void>;
  stop?(context: ModuleContext): void | Promise<void>;
}
