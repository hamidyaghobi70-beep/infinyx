import type { CoreModule, ModuleContext } from "../core/contracts.js";
import {
  AGENT_MODULE_ID,
  AGENT_MODULE_VERSION,
  type AgentRuntimeOptions,
  type AgentTaskRequest,
  type AgentTaskResult
} from "./agent-contracts.js";
import { AgentRuntime } from "./agent-runtime.js";
import { DisabledModelPort, type ModelPort } from "./model-port.js";

export interface AgentModuleOptions {
  readonly modelPort?: ModelPort;
  readonly runtime?: AgentRuntimeOptions;
}

/**
 * Internal CoreModule only. It registers no HTTP routes, tools, memory adapter,
 * external provider, or protected operation.
 */
export class AgentModule implements CoreModule {
  readonly id = AGENT_MODULE_ID;
  readonly version = AGENT_MODULE_VERSION;
  private readonly runtime: AgentRuntime;
  private initialized = false;
  private started = false;
  private shutdownSignal: AbortSignal | undefined;
  private readonly onCoreShutdown = (): void => {
    this.shutdownSignal?.removeEventListener("abort", this.onCoreShutdown);
    this.runtime.shutdown();
    this.started = false;
  };

  constructor(options: AgentModuleOptions = {}) {
    this.runtime = new AgentRuntime(options.modelPort ?? new DisabledModelPort(), options.runtime);
  }

  async initialize(context: ModuleContext): Promise<void> {
    if (context.moduleId !== this.id) throw new Error("Agent module received an invalid Core context.");
    if (this.initialized) throw new Error("Agent module is already initialized.");
    this.initialized = true;
    this.shutdownSignal = context.shutdownSignal;
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
    this.runtime.shutdown();
    this.started = false;
  }

  execute(request: AgentTaskRequest | unknown): Promise<AgentTaskResult> {
    return this.runtime.execute(request);
  }

  getTaskStatus(taskId: string) {
    return this.runtime.getTaskStatus(taskId);
  }

  get isAccepting(): boolean {
    return this.runtime.isAccepting;
  }
}
