import type {
  CoreLifecycleState,
  CoreModule,
  EventBusPort,
  MemoryPort,
  ModuleContext,
  ModuleLifecycleState,
  PolicyEngine
} from "./contracts.js";
import { DefaultDenyPolicyEngine } from "./default-policy-engine.js";
import { InMemoryEventBus } from "./event-bus.js";
import { CoreError } from "./core-error.js";
import { ModuleRegistry } from "./module-registry.js";

export interface CoreEngineOptions {
  readonly events?: EventBusPort;
  readonly policy?: PolicyEngine;
  readonly memory?: MemoryPort;
}

export class CoreEngine {
  readonly events: EventBusPort;
  readonly policy: PolicyEngine;
  readonly registry = new ModuleRegistry();

  private lifecycle: CoreLifecycleState = "created";
  private readonly moduleStates = new Map<string, ModuleLifecycleState>();
  private initializedModules: CoreModule[] = [];

  constructor(private readonly options: CoreEngineOptions = {}) {
    this.events = options.events ?? new InMemoryEventBus();
    this.policy = options.policy ?? new DefaultDenyPolicyEngine();
  }

  get state(): CoreLifecycleState {
    return this.lifecycle;
  }

  register(module: CoreModule): void {
    if (this.lifecycle !== "created") {
      throw new CoreError(
        "INVALID_LIFECYCLE_TRANSITION",
        "Modules can only be registered before initialization."
      );
    }
    this.registry.register(module);
    this.moduleStates.set(module.id, "registered");
  }

  getModuleStates(): ReadonlyMap<string, ModuleLifecycleState> {
    return new Map(this.moduleStates);
  }

  async initialize(): Promise<void> {
    this.assertState("created", "initialize");
    this.lifecycle = "initializing";

    try {
      for (const module of this.registry.resolveStartOrder()) {
        this.moduleStates.set(module.id, "initializing");
        await module.initialize?.(this.createContext(module.id));
        this.initializedModules.push(module);
        this.moduleStates.set(module.id, "initialized");
      }
      this.lifecycle = "initialized";
    } catch (error) {
      const failedModule = [...this.moduleStates.entries()]
        .find(([, state]) => state === "initializing")?.[0];
      if (failedModule) this.moduleStates.set(failedModule, "failed");
      this.lifecycle = "failed";
      const cleanupErrors = await this.cleanupInitializedModules();
      const failure = new CoreError(
        "MODULE_INITIALIZATION_FAILED",
        "Core Engine module initialization failed.",
        { cause: error }
      );
      if (cleanupErrors.length) {
        throw new AggregateError([failure, ...cleanupErrors], "Initialization and rollback failed.");
      }
      throw failure;
    }
  }

  async start(): Promise<void> {
    this.assertState("initialized", "start");
    this.lifecycle = "starting";

    try {
      for (const module of this.registry.resolveStartOrder()) {
        this.moduleStates.set(module.id, "starting");
        await module.start?.(this.createContext(module.id));
        this.moduleStates.set(module.id, "running");
      }
      this.lifecycle = "running";
    } catch (error) {
      const failedModule = [...this.moduleStates.entries()]
        .find(([, state]) => state === "starting")?.[0];
      if (failedModule) this.moduleStates.set(failedModule, "failed");
      this.lifecycle = "failed";
      const cleanupErrors = await this.cleanupInitializedModules();
      const failure = new CoreError(
        "MODULE_START_FAILED",
        "Core Engine module startup failed.",
        { cause: error }
      );
      if (cleanupErrors.length) {
        throw new AggregateError([failure, ...cleanupErrors], "Startup and rollback failed.");
      }
      throw failure;
    }
  }

  async stop(): Promise<void> {
    if (this.lifecycle === "stopped") return;
    if (this.lifecycle === "created") {
      this.lifecycle = "stopped";
      return;
    }
    if (!["initialized", "running", "failed"].includes(this.lifecycle)) {
      throw new CoreError(
        "INVALID_LIFECYCLE_TRANSITION",
        'Cannot stop Core Engine while it is "' + this.lifecycle + '".'
      );
    }

    this.lifecycle = "stopping";
    const errors = await this.cleanupInitializedModules();
    this.lifecycle = errors.length ? "failed" : "stopped";

    if (errors.length) {
      throw new CoreError(
        "MODULE_STOP_FAILED",
        "One or more modules failed to stop.",
        { cause: new AggregateError(errors) }
      );
    }
  }

  private createContext(moduleId: string): ModuleContext {
    const base = {
      moduleId,
      events: this.events,
      policy: this.policy
    };
    return Object.freeze(
      this.options.memory ? { ...base, memory: this.options.memory } : base
    );
  }

  private async cleanupInitializedModules(): Promise<unknown[]> {
    const errors: unknown[] = [];
    for (const module of [...this.initializedModules].reverse()) {
      this.moduleStates.set(module.id, "stopping");
      try {
        await module.stop?.(this.createContext(module.id));
        this.moduleStates.set(module.id, "stopped");
      } catch (error) {
        this.moduleStates.set(module.id, "failed");
        errors.push(error);
      }
    }
    this.initializedModules = [];
    return errors;
  }

  private assertState(expected: CoreLifecycleState, operation: string): void {
    if (this.lifecycle !== expected) {
      throw new CoreError(
        "INVALID_LIFECYCLE_TRANSITION",
        'Cannot ' + operation + ' Core Engine while it is "' + this.lifecycle + '".'
      );
    }
  }
}
