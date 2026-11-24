import type {
  CoreLifecycleState,
  CoreModule,
  EventBusPort,
  EventHandler,
  MemoryPort,
  ModuleContext,
  ModuleLifecycleState,
  PolicyEngine,
  PolicyRequest,
  PolicyDecision,
  MemoryAddress
} from "./contracts.js";
import { DefaultDenyPolicyEngine } from "./default-policy-engine.js";
import { InMemoryEventBus } from "./event-bus.js";
import { CoreError } from "./core-error.js";
import { ModuleRegistry } from "./module-registry.js";
import { RollbackCoordinator } from "./rollback-coordinator.js";
import { OperationRegistry } from "./operation-registry.js";

export interface CoreEngineOptions {
  readonly events?: EventBusPort;
  readonly policy?: PolicyEngine;
  readonly memory?: MemoryPort;
  readonly operationDrainTimeoutMs?: number;
}

export type CoreFailureReason = "drain_timeout" | "cleanup_error";

export class CoreEngine {
  readonly events: EventBusPort;
  readonly policy: PolicyEngine;

  private readonly moduleRegistry = new ModuleRegistry();
  private readonly operations = new OperationRegistry();
  private readonly memory: MemoryPort | undefined;
  private lifecycle: CoreLifecycleState = "created";
  private closingRequested = false;
  private failure: CoreFailureReason | undefined;
  private readonly rollbackCoordinator = new RollbackCoordinator();
  private readonly moduleStates = new Map<string, ModuleLifecycleState>();
  private initializedModules: CoreModule[] = [];
  private readonly cleanupInFlight = new Map<string, Promise<void>>();

  private readonly operationDrainTimeoutMs: number;

  constructor(options: CoreEngineOptions = {}) {
    this.operationDrainTimeoutMs = options.operationDrainTimeoutMs ?? 10_000;
    this.events = this.wrapEventBus(options.events ?? new InMemoryEventBus());
    this.policy = this.wrapPolicy(options.policy ?? new DefaultDenyPolicyEngine());
    this.memory = options.memory ? this.wrapMemory(options.memory) : undefined;
  }

  get state(): CoreLifecycleState {
    return this.closingRequested && !["stopped", "failed"].includes(this.lifecycle)
      ? "closing"
      : this.lifecycle;
  }

  get failureReason(): CoreFailureReason | undefined {
    return this.failure;
  }

  get activeOperationCount(): number {
    return this.operations.activeHandleCount;
  }

  get activePromiseCount(): number {
    return this.operations.activePromiseCount;
  }

  /** Close independent admission immediately; valid in-flight parents may settle children. */
  requestClose(): void {
    this.closingRequested = true;
    this.operations.closeAdmission();
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
        if (this.closingRequested) break;
        this.moduleStates.set(module.id, "initializing");
        this.initializedModules.push(module);
        await this.operations.run(() => module.initialize?.(this.createContext(module.id)));
        this.moduleStates.set(module.id, "initialized");
      }
      this.lifecycle = "initialized";
    } catch (error) {
      const failedModule = [...this.moduleStates.entries()]
        .find(([, state]) => state === "initializing")?.[0];
      this.lifecycle = "failed";
      let rollbackFailed = false;
      let rollbackError: unknown;
      this.requestClose();
      try {
        await this.drainOperations();
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
        if (this.closingRequested) break;
        this.moduleStates.set(module.id, "starting");
        await this.operations.run(() => module.start?.(this.createContext(module.id)));
        this.moduleStates.set(module.id, "running");
      }
      this.lifecycle = "running";
    } catch (error) {
      const failedModule = [...this.moduleStates.entries()]
        .find(([, state]) => state === "starting")?.[0];
      this.lifecycle = "failed";
      let rollbackFailed = false;
      let rollbackError: unknown;
      this.requestClose();
      try {
        await this.drainOperations();
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
      this.requestClose();
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
      try {
        await this.drainOperations();
      } catch (error) {
        this.lifecycle = "failed";
        this.failure = "drain_timeout";
        throw error;
      }
      await this.performStop();
    });
  }

  private async drainOperations(): Promise<void> {
    await this.operations.drain(this.operationDrainTimeoutMs);
    if (this.failure === "drain_timeout") this.failure = undefined;
  }

  private async performStartupRollback(
    preserveFailureIds: ReadonlySet<string>
  ): Promise<void> {
    const errors = await this.cleanupInitializedModules(preserveFailureIds);
    try {
      await this.drainOperations();
    } catch (error) {
      this.failure = "drain_timeout";
      throw error;
    }
    if (errors.length) {
      this.failure = "cleanup_error";
      throw new AggregateError(errors, "Startup rollback cleanup failed.");
    }
  }

  private async performStop(): Promise<void> {
    const errors = await this.cleanupInitializedModules();
    try {
      await this.drainOperations();
    } catch (error) {
      this.lifecycle = "failed";
      this.failure = "drain_timeout";
      throw error;
    }
    this.lifecycle = errors.length ? "failed" : "stopped";
    this.failure = errors.length ? "cleanup_error" : undefined;

    if (errors.length) {
      throw new CoreError(
        "MODULE_STOP_FAILED",
        "One or more modules failed to stop.",
        { cause: new AggregateError(errors) }
      );
    }
  }

  private wrapEventBus(events: EventBusPort): EventBusPort {
    return Object.freeze({
      subscribe: <TPayload>(type: string, handler: EventHandler<TPayload>): (() => void) => {
        this.operations.assertSynchronousAdmission();
        return events.subscribe(type, handler);
      },
      publish: <TPayload>(type: string, payload: TPayload): Promise<void> =>
        this.operations.run(() => events.publish(type, payload))
    });
  }

  private wrapPolicy(policy: PolicyEngine): PolicyEngine {
    return Object.freeze({
      evaluate: (request: PolicyRequest): Promise<PolicyDecision> =>
        this.operations.run(() => policy.evaluate(request))
    });
  }

  private wrapMemory(memory: MemoryPort): MemoryPort {
    return Object.freeze({
      read: (address: MemoryAddress): Promise<unknown | null> =>
        this.operations.run(() => memory.read(address)),
      write: (address: MemoryAddress, value: unknown): Promise<void> =>
        this.operations.run(() => memory.write(address, value)),
      delete: (address: MemoryAddress): Promise<void> =>
        this.operations.run(() => memory.delete(address))
    });
  }

  private createContext(moduleId: string): ModuleContext {
    const base = {
      moduleId,
      events: this.events,
      policy: this.policy
    };
    return Object.freeze(this.memory ? { ...base, memory: this.memory } : base);
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

    const cleanup = this.operations.runCleanup(async (): Promise<void> => {
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
    if (this.closingRequested || this.lifecycle !== expected) {
      throw new CoreError(
        "INVALID_LIFECYCLE_TRANSITION",
        'Cannot ' + operation + ' Core Engine while it is "' + this.state + '".'
      );
    }
  }
}
