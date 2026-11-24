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
import { RollbackCoordinator } from "./rollback-coordinator.js";

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
  private closingRequested = false;
  private readonly rollbackCoordinator = new RollbackCoordinator();
  private readonly moduleStates = new Map<string, ModuleLifecycleState>();
  private initializedModules: CoreModule[] = [];
  private readonly cleanupInFlight = new Map<string, Promise<void>>();

  constructor(private readonly options: CoreEngineOptions = {}) {
    this.events = options.events ?? new InMemoryEventBus();
    this.policy = options.policy ?? new DefaultDenyPolicyEngine();
  }

  get state(): CoreLifecycleState {
    return this.closingRequested && this.lifecycle !== "stopped"
      ? "closing"
      : this.lifecycle;
  }

  /** Close admission immediately; in-flight lifecycle hooks are allowed to settle. */
  requestClose(): void {
    this.closingRequested = true;
  }

  getModules(): readonly CoreModule[] {
    return this.moduleRegistry.list();
  }

  register(module: CoreModule): void {
    if (this.closingRequested || this.lifecycle !== "created") {
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
      let rollbackFailed = false;
      let rollbackError: unknown;
      try {
        await this.rollbackCoordinator.run(() =>
          this.performStartupRollback(failedModule ? new Set([failedModule]) : new Set())
        );
      } catch (cleanupError) {
        rollbackFailed = true;
        rollbackError = cleanupError;
      }
      const failure = new CoreError(
        "MODULE_INITIALIZATION_FAILED",
        "Core Engine module initialization failed.",
        { cause: error }
      );
      if (rollbackFailed) {
        throw new AggregateError([failure, rollbackError], "Initialization and rollback failed.");
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
      let rollbackFailed = false;
      let rollbackError: unknown;
      try {
        await this.rollbackCoordinator.run(() =>
          this.performStartupRollback(failedModule ? new Set([failedModule]) : new Set())
        );
      } catch (cleanupError) {
        rollbackFailed = true;
        rollbackError = cleanupError;
      }
      const failure = new CoreError(
        "MODULE_START_FAILED",
        "Core Engine module startup failed.",
        { cause: error }
      );
      if (rollbackFailed) {
        throw new AggregateError([failure, rollbackError], "Startup and rollback failed.");
      }
      throw failure;
    }
  }

  stop(): Promise<void> {
    return this.rollbackCoordinator.run(async () => {
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
      await this.performStop();
    });
  }

  private async performStartupRollback(
    preserveFailureIds: ReadonlySet<string>
  ): Promise<void> {
    const errors = await this.cleanupInitializedModules(preserveFailureIds);
    if (errors.length) {
      throw new AggregateError(errors, "Startup rollback cleanup failed.");
    }
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
    const errors: unknown[] = [];
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

    const cleanup = (async (): Promise<void> => {
      this.moduleStates.set(module.id, "cleaning");
      try {
        await module.stop?.(this.createContext(module.id));
        this.moduleStates.set(module.id, preserveFailure ? "failed" : "stopped");
        this.initializedModules = this.initializedModules.filter(
          (initialized) => initialized.id !== module.id
        );
      } catch (error) {
        this.moduleStates.set(module.id, "failed");
        throw error;
      }
    })();

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
    if (this.closingRequested || this.lifecycle !== expected) {
      throw new CoreError(
        "INVALID_LIFECYCLE_TRANSITION",
        'Cannot ' + operation + ' Core Engine while it is "' + this.state + '".'
      );
    }
  }
}
