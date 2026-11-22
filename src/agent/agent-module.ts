import type { CoreEngine } from "../core/core-engine.js";
import type {
  CoreModule,
  ModuleContext,
  ProtectedOperationCaller,
  ProtectedOperationHandle,
  ProtectedOperationPort
} from "../core/contracts.js";
import {
  AGENT_MODULE_ID,
  AGENT_MODULE_VERSION,
  type AgentRuntimeOptions,
  type AgentTaskRequest,
  type AgentTaskResult
} from "./agent-contracts.js";
import { AgentRuntime } from "./agent-runtime.js";
import { DisabledModelPort, type ModelPort } from "./model-port.js";

/**
 * This provider must be supplied by the trusted host composition root.
 * A caller-supplied actorId is an authorization attribute, not authentication.
 */
export type TrustedAgentCallerProvider = () => ProtectedOperationCaller | undefined;

export interface AgentModuleOptions {
  readonly modelPort?: ModelPort;
  readonly runtime?: AgentRuntimeOptions;
  readonly callerProvider?: TrustedAgentCallerProvider;
}

function isPlainAgentRequest(value: unknown): value is AgentTaskRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Internal CoreModule only. Agent execution is exposed exclusively through a
 * Core-registered Protected Operation; no direct Runtime execution route exists.
 */
export class AgentModule implements CoreModule {
  readonly id = AGENT_MODULE_ID;
  readonly version = AGENT_MODULE_VERSION;
  private readonly runtime: AgentRuntime;
  private readonly callerProvider?: TrustedAgentCallerProvider;
  private operationHandle?: ProtectedOperationHandle<AgentTaskRequest, AgentTaskResult>;
  private protectedOperations?: ProtectedOperationPort;
  private initialized = false;
  private started = false;
  private shutdownSignal: AbortSignal | undefined;
  private readonly onCoreShutdown = (): void => {
    this.shutdownSignal?.removeEventListener("abort", this.onCoreShutdown);
    // ProtectedOperationExecutor also aborts the operation context. Its handler
    // awaits AgentRuntime.execute() until the actual ModelPort promise settles.
    void this.runtime.shutdown();
    this.started = false;
  };

  constructor(options: AgentModuleOptions = {}) {
    this.runtime = new AgentRuntime(options.modelPort ?? new DisabledModelPort(), options.runtime);
    this.callerProvider = options.callerProvider;
  }

  /**
   * Composition-root helper. Register the protected operation before Core
   * initialization, then register this module. The caller provider is a trusted
   * host dependency; without it, execution fails closed.
   */
  registerWithCore(core: CoreEngine): void {
    if (this.operationHandle) throw new Error("Agent module is already registered with Core.");
    this.operationHandle = core.registerProtectedOperation<AgentTaskRequest, AgentTaskResult>({
      id: "agent.execute",
      action: "agent.execute",
      resource: "agent:agent",
      validateInput: isPlainAgentRequest,
      handler: (request, context) => this.runtime.execute(request, context.signal)
    });
    core.register(this);
  }

  async initialize(context: ModuleContext): Promise<void> {
    if (context.moduleId !== this.id) throw new Error("Agent module received an invalid Core context.");
    if (this.initialized) throw new Error("Agent module is already initialized.");
    this.initialized = true;
    this.shutdownSignal = context.shutdownSignal;
    this.protectedOperations = context.protectedOperations;
    if (this.shutdownSignal?.aborted) this.onCoreShutdown();
    else this.shutdownSignal?.addEventListener("abort", this.onCoreShutdown, { once: true });
  }

  async start(context: ModuleContext): Promise<void> {
    if (context.moduleId !== this.id || !this.initialized || this.started || context.shutdownSignal?.aborted) {
      throw new Error("Agent module lifecycle is invalid.");
    }
    this.runtime.start();
    this.started = true;
  }

  async stop(context: ModuleContext): Promise<void> {
    if (context.moduleId !== this.id) throw new Error("Agent module received an invalid Core context.");
    this.shutdownSignal?.removeEventListener("abort", this.onCoreShutdown);
    this.started = false;
    await this.runtime.shutdown();
  }

  async execute(request: AgentTaskRequest | unknown): Promise<AgentTaskResult> {
    if (!this.started || !this.operationHandle || !this.protectedOperations) {
      return { status: "rejected", taskId: "unknown", reason: "Agent module is not available." };
    }
    let providedCaller: ProtectedOperationCaller | undefined;
    try {
      providedCaller = this.callerProvider?.();
      if (!providedCaller) {
        return { status: "rejected", taskId: "unknown", reason: "Trusted Agent caller is unavailable; execution denied." };
      }
      // Create a fresh request envelope for Core's in-memory duplicate suppression.
      // The trusted principal provider may legitimately reuse an immutable principal object.
      const caller: ProtectedOperationCaller = Object.freeze({
        actorId: providedCaller.actorId,
        ...(providedCaller.context === undefined ? {} : { context: providedCaller.context })
      });
      const result = await this.protectedOperations.execute(
        this.operationHandle,
        caller,
        request as AgentTaskRequest
      );
      if (result.status === "executed") return result.value;
      return {
        status: "rejected",
        taskId: "unknown",
        reason: result.reason
      };
    } catch {
      return { status: "rejected", taskId: "unknown", reason: "Trusted Agent caller could not be established." };
    }
  }

  getTaskStatus(taskId: string) {
    return this.runtime.getTaskStatus(taskId);
  }

  get isAccepting(): boolean {
    return this.started && this.runtime.isAccepting;
  }
}
