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

export interface PolicyRequest {
  readonly actorId: string;
  readonly action: string;
  readonly resource: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

export interface PolicyDecision {
  readonly effect: "allow" | "deny";
  readonly reason: string;
}

export interface PolicyEngine {
  evaluate(request: PolicyRequest): Promise<PolicyDecision>;
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
