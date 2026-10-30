import { AsyncLocalStorage } from "node:async_hooks";
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

interface CleanupExecutionContext {
  readonly engine: CoreEngine;
  active: boolean;
}

export interface CoreEngineOptions {
  readonly events?: EventBusPort;
  readonly policy?: PolicyEngine;
  readonly memory?: MemoryPort;
}

export class CoreEngine {
  readonly events: EventBusPort;
  readonly policy: PolicyEngine;

  private readonly moduleRegistry = new ModuleRegistry();
  private lifecycle: CoreLifecycleState = "created";
  private readonly moduleStates = new Map<string, ModuleLifecycleState>();
  private initializedModules: CoreModule[] = [];
  private readonly cleanupInFlight = new Map<string, Promise<void>>();
  // Cleanup is at-most-once per module. A failed attempt remains terminal and
  // is re-reported by later stop() calls; CoreEngine never retries implicitly.
  private readonly cleanupAttempted = new Set<string>();
  private readonly cleanupFailures = new Map<string, unknown>();
  private readonly cleanupContext = new AsyncLocalStorage<CleanupExecutionContext>();
  private stopPromise: Promise<void> | undefined;

  constructor(private readonly options: CoreEngineOptions = {}) {
    this.events = options.events ?? new InMemoryEventBus();
    this.policy = options.policy ?? new DefaultDenyPolicyEngine();
  }

  get state(): CoreLifecycleState {
    return this.lifecycle;
  }

  getModules(): readonly CoreModule[] {
    return this.moduleRegistry.list();
  }

  register(module: CoreModule): void {
    if (this.lifecycle !== "created") {
      throw new CoreError(
        "INVALID_LIFECYCLE_TRANSITION",
        "Modules can only be registered before initialization."
      );
    }
    this.moduleRegistry.register(module);
    this.moduleStates.set(module.id, "registered");
  }

  getModuleStates(): ReadonlyMap<string, ModuleLifecycleState> {
    return new Map(this.moduleStates);
  }

  async initialize(): Promise<void> {
    this.assertState("created", "initialize");
    this.lifecycle = "initializing";

    try {
      for (const module of this.moduleRegistry.resolveStartOrder()) {
        this.moduleStates.set(module.id, "initializing");
        // Track before invoking the hook so rollback also cleans up a module
        // whose initialization failed after partially allocating resources.
        this.initializedModules.push(module);
        await module.initialize?.(this.createContext(module.id));
        this.moduleStates.set(module.id, "initialized");
      }
      this.lifecycle = "initialized";
    } catch (error) {
      const failedModule = [...this.moduleStates.entries()]
        .find(([, state]) => state === "initializing")?.[0];
      this.lifecycle = "failed";
      const cleanupErrors = await this.cleanupInitializedModules(
        failedModule ? new Set([failedModule]) : new Set()
      );
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
      for (const module of this.moduleRegistry.resolveStartOrder()) {
        this.moduleStates.set(module.id, "starting");
        await module.start?.(this.createContext(module.id));
        this.moduleStates.set(module.id, "running");
      }
      this.lifecycle = "running";
    } catch (error) {
      const failedModule = [...this.moduleStates.entries()]
        .find(([, state]) => state === "starting")?.[0];
      this.lifecycle = "failed";
      const cleanupErrors = await this.cleanupInitializedModules(
        failedModule ? new Set([failedModule]) : new Set()
      );
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

  stop(): Promise<void> {
    // Returning the in-flight stop promise from inside a stop hook would make
    // that hook await the operation that is itself waiting for the hook.
    // Detect this async call chain explicitly instead of creating a deadlock.
    const cleanupContext = this.cleanupContext.getStore();
    if (cleanupContext?.engine === this && cleanupContext.active) {
      return Promise.reject(new CoreError(
        "INVALID_LIFECYCLE_TRANSITION",
        "Re-entrant stop() from a module cleanup hook is not allowed."
      ));
    }
    if (this.stopPromise) return this.stopPromise;
    if (this.lifecycle === "stopped") return Promise.resolve();
    if (this.lifecycle === "created") {
      this.lifecycle = "stopped";
      return Promise.resolve();
    }
    if (!["initialized", "running", "failed"].includes(this.lifecycle)) {
      return Promise.reject(new CoreError(
        "INVALID_LIFECYCLE_TRANSITION",
        'Cannot stop Core Engine while it is "' + this.lifecycle + '".'
      ));
    }

    this.lifecycle = "stopping";
    // Defer execution one microtask so the shared promise is installed before
    // any module stop hook can re-enter CoreEngine.stop().
    const stopPromise = Promise.resolve().then(() => this.performStop());
    this.stopPromise = stopPromise;
    void stopPromise.then(
      () => {
        if (this.stopPromise === stopPromise) this.stopPromise = undefined;
      },
      () => {
        if (this.stopPromise === stopPromise) this.stopPromise = undefined;
      }
    );
    return stopPromise;
  }

  private async performStop(): Promise<void> {
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

  private async cleanupInitializedModules(
    preserveFailureIds: ReadonlySet<string> = new Set()
  ): Promise<unknown[]> {
    const errors: unknown[] = [...this.cleanupFailures.values()];
    for (const module of [...this.initializedModules].reverse()) {
      try {
        await this.cleanupModule(module, preserveFailureIds.has(module.id));
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  private async cleanupModule(module: CoreModule, preserveFailure: boolean): Promise<void> {
    const inFlight = this.cleanupInFlight.get(module.id);
    if (inFlight) {
      await inFlight;
      return;
    }
    if (this.cleanupAttempted.has(module.id)) {
      if (this.cleanupFailures.has(module.id)) {
        throw this.cleanupFailures.get(module.id);
      }
      return;
    }

    // Mark before invoking user code so retries/concurrent callers cannot run
    // the same hook twice, including when the hook throws synchronously.
    this.cleanupAttempted.add(module.id);
    const cleanup = Promise.resolve().then(async (): Promise<void> => {
      this.moduleStates.set(module.id, "cleaning");
      const context: CleanupExecutionContext = { engine: this, active: true };
      try {
        await this.cleanupContext.run(context, async () => {
          await module.stop?.(this.createContext(module.id));
        });
        this.moduleStates.set(module.id, preserveFailure ? "failed" : "stopped");
      } catch (error) {
        this.moduleStates.set(module.id, "failed");
        this.cleanupFailures.set(module.id, error);
        throw error;
      } finally {
        // Async resources created by the hook retain the same context object.
        // Deactivating it distinguishes detached callbacks from active re-entry.
        context.active = false;
        this.initializedModules = this.initializedModules.filter(
          (initialized) => initialized.id !== module.id
        );
      }
    });

    this.cleanupInFlight.set(module.id, cleanup);
    try {
      await cleanup;
    } finally {
      if (this.cleanupInFlight.get(module.id) === cleanup) {
        this.cleanupInFlight.delete(module.id);
      }
    }
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
