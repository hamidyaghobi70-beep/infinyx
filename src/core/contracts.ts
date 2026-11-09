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

/**
 * Optional, caller-supplied policy context. Context is a structured envelope;
 * arbitrary key/value attributes belong inside context.attributes and are not
 * themselves the Context object.
 */
export interface PolicyContext {
  readonly attributes?: Readonly<Record<string, unknown>>;
}

/**
 * Authorization input contract:
 * - actorId, action, and resource are required non-empty strings.
 * - context is optional; when present it must be a PolicyContext object.
 * - context.attributes is optional and, when present, must be a string-keyed
 *   object. Attribute values are opaque to the core policy boundary.
 */
export interface PolicyRequest {
  readonly actorId: string;
  readonly action: string;
  readonly resource: string;
  readonly context?: PolicyContext;
}

/** Optional cancellation controls for a single policy evaluation. */
export interface PolicyEvaluationOptions {
  readonly signal?: AbortSignal;
}

export interface PolicyDecision {
  readonly effect: "allow" | "deny";
  readonly reason: string;
}

export interface PolicyEngine {
  /**
   * The options argument is optional to preserve existing evaluate(request)
   * call sites and implementations that only accept the original argument.
   */
  evaluate(
    request: PolicyRequest,
    options?: PolicyEvaluationOptions
  ): Promise<PolicyDecision>;
}


/** Caller-supplied authorization attributes. actorId is not authenticated by Core. */
export interface ProtectedOperationCaller {
  readonly actorId: string;
  readonly context?: PolicyContext;
}

/** Opaque operation reference; valid references are issued by the Core composition root. */
export interface ProtectedOperationHandle<TInput = unknown, TOutput = unknown> {
  readonly id: string;
}

export interface ProtectedOperationContext {
  readonly operationId: string;
  readonly signal: AbortSignal;
}

export interface ProtectedOperationDefinition<TInput, TOutput> {
  readonly id: string;
  readonly action: string;
  readonly resource: string;
  readonly validateInput: (value: unknown) => value is TInput;
  readonly handler: (
    input: TInput,
    context: ProtectedOperationContext
  ) => TOutput | Promise<TOutput>;
}

export type ProtectedOperationResult<TOutput> =
  | { readonly status: "executed"; readonly value: TOutput }
  | { readonly status: "denied"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string };

/** Execute-only capability supplied to modules; registration is not exposed. */
export interface ProtectedOperationPort {
  execute<TInput, TOutput>(
    operation: ProtectedOperationHandle<TInput, TOutput>,
    caller: ProtectedOperationCaller,
    input: TInput,
    options?: PolicyEvaluationOptions
  ): Promise<ProtectedOperationResult<TOutput>>;
}

export interface ModuleContext {
  readonly moduleId: string;
  readonly events: EventBusPort;
  readonly policy: PolicyEngine;
  readonly protectedOperations: ProtectedOperationPort;
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
