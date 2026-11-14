import { AsyncLocalStorage } from "node:async_hooks";
import { GuardedMemoryPort } from "./guarded-memory-port.js";
import type {
  CoreLifecycleState,
  CoreModule,
  EventBusPort,
  ModuleContext,
  ModuleLifecycleState,
  PolicyEngine,
  PolicyEvaluationOptions,
  ProtectedOperationCaller,
  ProtectedOperationDefinition,
  ProtectedOperationHandle,
  ProtectedOperationPort
} from "./contracts.js";
import { DefaultDenyPolicyEngine } from "./default-policy-engine.js";
import { FailClosedPolicyEngine } from "./fail-closed-policy-engine.js";
import { InMemoryEventBus } from "./event-bus.js";
import { CoreError, type CoreShutdownBlocker, type CoreShutdownBlockerCode } from "./core-error.js";
import { ModuleRegistry } from "./module-registry.js";
import { ProtectedOperationExecutor } from "./protected-operation-executor.js";

interface CleanupExecutionContext {
  readonly engine: CoreEngine;
  active: boolean;
}

export interface CoreEngineOptions {
  readonly events?: EventBusPort;
  readonly policy?: PolicyEngine;
  /** Creates a module-specific guarded memory capability; raw MemoryPort values are rejected. */
  readonly memory?: (moduleId: string) => GuardedMemoryPort;
  /** Maximum time allowed for an injected policy evaluation. Defaults to 5 seconds. */
  readonly policyTimeoutMs?: number;
  readonly protectedOperationShutdown?: {
    readonly drainDeadlineMs?: number;
  };
}

export class CoreEngine {
  readonly events: EventBusPort;
  readonly policy: PolicyEngine;
  readonly protectedOperations: ProtectedOperationPort;

  private readonly protectedOperationExecutor: ProtectedOperationExecutor;
  private readonly moduleRegistry = new ModuleRegistry();
  private lifecycle: CoreLifecycleState = "created";
  private readonly moduleStates = new Map<string, ModuleLifecycleState>();
  private initializedModules: CoreModule[] = [];
  private readonly cleanupInFlight = new Map<string, Promise<void>>();
  private readonly cleanupContext = new AsyncLocalStorage<CleanupExecutionContext>();
  private stopPromise: Promise<void> | undefined;
  private readonly drainDeadlineMs: number;
  private shutdownInitiated = false;
  private executorDrainPromise: Promise<void> | undefined;
  private policyShutdownPromise: Promise<void> | undefined;
  private executorDrainSettled = false;
  private policyShutdownSettled = false;
  private executorDrainSettledAt: number | undefined;
  private policyShutdownSettledAt: number | undefined;
  private executorDrainFailure: CoreError | undefined;
  private policyShutdownFailure: CoreError | undefined;
  private readonly moduleMemory = new Map<string, GuardedMemoryPort>();

  constructor(private readonly options: CoreEngineOptions = {}) {
    const shutdownConfig = options.protectedOperationShutdown;
    if (shutdownConfig !== undefined &&
        (typeof shutdownConfig !== "object" || shutdownConfig === null)) {
      throw new CoreError(
        "PROTECTED_OPERATION_SHUTDOWN_CONFIG_INVALID",
        "Protected-operation shutdown configuration is invalid."
      );
    }
    const hasExplicitDrainDeadline = shutdownConfig !== undefined &&
      Object.prototype.hasOwnProperty.call(shutdownConfig, "drainDeadlineMs");
    const configuredDrainDeadline = shutdownConfig?.drainDeadlineMs;
    if (hasExplicitDrainDeadline &&
        (!Number.isSafeInteger(configuredDrainDeadline) ||
         (configuredDrainDeadline as number) < 1 ||
         (configuredDrainDeadline as number) > 2_147_483_647)) {
      throw new CoreError(
        "PROTECTED_OPERATION_SHUTDOWN_CONFIG_INVALID",
        "Protected-operation shutdown drain deadline configuration is invalid."
      );
    }
    this.drainDeadlineMs = hasExplicitDrainDeadline
      ? configuredDrainDeadline as number
      : 30_000;
    this.events = options.events ?? new InMemoryEventBus();
    this.policy = options.policy
      ? new FailClosedPolicyEngine(options.policy, options.policyTimeoutMs)
      : new DefaultDenyPolicyEngine();
    this.protectedOperationExecutor = new ProtectedOperationExecutor(
      this.policy,
      () => this.lifecycle === "running"
    );
    this.protectedOperations = Object.freeze({
      execute: <TInput, TOutput>(
        operation: ProtectedOperationHandle<TInput, TOutput>,
        caller: ProtectedOperationCaller,
        input: TInput,
        options?: PolicyEvaluationOptions
      ) => this.protectedOperationExecutor.execute(operation, caller, input, options)
    });
  }

  get state(): CoreLifecycleState {
    return this.lifecycle;
  }

  getModules(): readonly CoreModule[] {
    return this.moduleRegistry.list();
  }

  /** Register protected handlers during composition, before modules receive context. */
  registerProtectedOperation<TInput, TOutput>(
    definition: ProtectedOperationDefinition<TInput, TOutput>
  ): ProtectedOperationHandle<TInput, TOutput> {
    if (this.lifecycle !== "created") {
      throw new CoreError(
        "INVALID_LIFECYCLE_TRANSITION",
        "Protected operations can only be registered before initialization."
      );
    }
    return this.protectedOperationExecutor.register(definition);
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
    const cleanupContext = this.cleanupContext.getStore();
    if (cleanupContext?.engine === this && cleanupContext.active) {
      return Promise.reject(new CoreError(
        "INVALID_LIFECYCLE_TRANSITION",
        "Re-entrant stop() from a module cleanup hook is not allowed."
      ));
    }
    if (this.stopPromise) return this.stopPromise;
    if (this.lifecycle === "stopped") return Promise.resolve();
    if (!["created", "initialized", "running", "failed", "stopping"].includes(this.lifecycle)) {
      return Promise.reject(new CoreError(
        "INVALID_LIFECYCLE_TRANSITION",
        'Cannot stop Core Engine while it is "' + this.lifecycle + '".'
      ));
    }

    this.lifecycle = "stopping";
    // The shared promise is installed before either shutdown path is initiated.
    // Both paths are closed/started synchronously in the same JavaScript turn.
    return this.installStopPromise(() => this.performStop());
  }

  private installStopPromise(start: () => Promise<void>): Promise<void> {
    let resolveWork!: () => void;
    let rejectWork!: (reason?: unknown) => void;
    const stopPromise = new Promise<void>((resolve, reject) => {
      resolveWork = resolve;
      rejectWork = reject;
    });
    this.stopPromise = stopPromise;

    try {
      void start().then(resolveWork, rejectWork);
    } catch (error) {
      rejectWork(error);
    }

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

  private beginShutdownInitiation(): void {
    if (this.shutdownInitiated) return;
    this.shutdownInitiated = true;

    try {
      this.protectedOperationExecutor.closeAdmission();
      this.executorDrainPromise = this.protectedOperationExecutor.drain().catch(() => {
        const failure = new CoreError(
          "PROTECTED_OPERATION_SHUTDOWN_FAILED",
          "Protected-operation shutdown could not establish a complete drain."
        );
        this.executorDrainFailure = failure;
        throw failure;
      }).finally(() => {
        this.executorDrainSettled = true;
        this.executorDrainSettledAt = performance.now();
      });
    } catch {
      const failure = new CoreError(
        "PROTECTED_OPERATION_SHUTDOWN_FAILED",
        "Protected-operation shutdown initiation failed."
      );
      this.executorDrainFailure = failure;
      this.executorDrainSettled = true;
      this.executorDrainSettledAt = performance.now();
      this.executorDrainPromise = Promise.reject(failure);
    }
    void this.executorDrainPromise.catch(() => undefined);

    // Always attempt policy shutdown, even if executor shutdown initiation failed.
    try {
      this.policyShutdownPromise = Promise.resolve(this.policy.shutdown?.()).catch(() => {
        const failure = new CoreError(
          "POLICY_SHUTDOWN_FAILED",
          "Policy runtime shutdown failed."
        );
        this.policyShutdownFailure = failure;
        throw failure;
      }).finally(() => {
        this.policyShutdownSettled = true;
        this.policyShutdownSettledAt = performance.now();
      });
    } catch {
      const failure = new CoreError(
        "POLICY_SHUTDOWN_FAILED",
        "Policy runtime shutdown initiation failed."
      );
      this.policyShutdownFailure = failure;
      this.policyShutdownSettled = true;
      this.policyShutdownSettledAt = performance.now();
      this.policyShutdownPromise = Promise.reject(failure);
    }
    void this.policyShutdownPromise.catch(() => undefined);
  }

  private async performStop(): Promise<void> {
    // Start the shared monotonic budget before initiating either shutdown path.
    const deadline = performance.now() + this.drainDeadlineMs;
    this.beginShutdownInitiation();

    const executorDrain = this.executorDrainPromise ?? Promise.resolve();
    const policyShutdown = this.policyShutdownPromise ?? Promise.resolve();
    const remainingMs = Math.max(0, deadline - performance.now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), remainingMs);
    });

    let bothSettledBeforeDeadline = false;
    try {
      const drained = Promise.allSettled([executorDrain, policyShutdown]).then(() => true as const);
      const completed = await Promise.race([drained, timedOut]);
      bothSettledBeforeDeadline = completed && performance.now() <= deadline;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    const blockers: CoreShutdownBlocker[] = [];
    if (this.executorDrainFailure) {
      blockers.push({
        code: "PROTECTED_OPERATION_SHUTDOWN_FAILED",
        subsystem: "protected_operations",
        state: "failed"
      });
    }
    if (this.policyShutdownFailure) {
      blockers.push({
        code: "POLICY_SHUTDOWN_FAILED",
        subsystem: "policy",
        state: "failed"
      });
    }
    if (!this.executorDrainSettled ||
        (this.executorDrainSettledAt !== undefined &&
         this.executorDrainSettledAt > deadline && !this.executorDrainFailure)) {
      blockers.push({
        code: "PROTECTED_OPERATION_DRAIN_TIMEOUT",
        subsystem: "protected_operations",
        state: "unresolved"
      });
    }
    if (!this.policyShutdownSettled ||
        (this.policyShutdownSettledAt !== undefined &&
         this.policyShutdownSettledAt > deadline && !this.policyShutdownFailure)) {
      blockers.push({
        code: "POLICY_EVALUATION_DRAIN_TIMEOUT",
        subsystem: "policy",
        state: "unresolved"
      });
    }

    if (!bothSettledBeforeDeadline && blockers.length === 0) {
      blockers.push({
        code: "POLICY_EVALUATION_DRAIN_TIMEOUT",
        subsystem: "policy",
        state: "unresolved"
      });
    }

    if (blockers.length > 0) {
      const precedence: readonly CoreShutdownBlockerCode[] = [
        "POLICY_SHUTDOWN_FAILED",
        "PROTECTED_OPERATION_SHUTDOWN_FAILED",
        "POLICY_EVALUATION_DRAIN_TIMEOUT",
        "PROTECTED_OPERATION_DRAIN_TIMEOUT"
      ];
      blockers.sort((left, right) =>
        precedence.indexOf(left.code) - precedence.indexOf(right.code)
      );
      throw new CoreError(
        blockers[0]!.code,
        "Shutdown is blocked; module cleanup was not started.",
        undefined,
        blockers
      );
    }

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
      protectedOperations: this.protectedOperations
    };
    if (!this.options.memory) return Object.freeze(base);

    let memory = this.moduleMemory.get(moduleId);
    if (!memory) {
      const candidate = this.options.memory(moduleId);
      if (!(candidate instanceof GuardedMemoryPort) || candidate.scopeModuleId !== moduleId) {
        throw new CoreError(
          "INVALID_MEMORY_CAPABILITY",
          "Core Engine requires a GuardedMemoryPort bound to the receiving module."
        );
      }
      memory = candidate;
      this.moduleMemory.set(moduleId, memory);
    }
    return Object.freeze({ ...base, memory });
  }

  private async cleanupInitializedModules(
    preserveFailureIds: ReadonlySet<string> = new Set()
  ): Promise<unknown[]> {
    const errors: unknown[] = [];
    for (const module of [...this.initializedModules].reverse()) {
      // Never tear down a dependency while a dependent is still pending,
      // cleaning, or has failed cleanup. Successful dependents leave this queue.
      const unresolvedDependents = this.initializedModules.filter((dependent) =>
        dependent.id !== module.id &&
        (dependent.dependencies ?? []).includes(module.id)
      );
      if (unresolvedDependents.length > 0) {
        const names = unresolvedDependents.map((dependent) => dependent.id).join(", ");
        errors.push(new CoreError(
          "MODULE_DEPENDENCY_CLEANUP_BLOCKED",
          'Cannot clean up dependency "' + module.id +
            '" while dependent module(s) remain unresolved: ' + names + "."
        ));
        continue;
      }
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
      const context: CleanupExecutionContext = { engine: this, active: true };
      try {
        await this.cleanupContext.run(context, async () => {
          await module.stop?.(this.createContext(module.id));
        });
        this.moduleStates.set(module.id, preserveFailure ? "failed" : "stopped");
        // Successful hooks leave the retry queue. Failed hooks remain queued
        // for an explicit later stop() call; successful siblings never rerun.
        this.initializedModules = this.initializedModules.filter(
          (initialized) => initialized.id !== module.id
        );
      } catch (error) {
        this.moduleStates.set(module.id, "failed");
        throw error;
      } finally {
        // Async resources created by the hook retain the same context object.
        // Deactivating it distinguishes detached callbacks from active re-entry.
        context.active = false;
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
    if (this.lifecycle !== expected) {
      throw new CoreError(
        "INVALID_LIFECYCLE_TRANSITION",
        'Cannot ' + operation + ' Core Engine while it is "' + this.lifecycle + '".'
      );
    }
  }
}
