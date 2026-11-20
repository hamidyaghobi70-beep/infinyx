import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
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
import { CoreError } from "./core-error.js";
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
  /** Shared monotonic deadline for protected-handler and policy shutdown draining. */
  readonly protectedOperationShutdown?: { readonly drainDeadlineMs?: number };
}

export class CoreEngine {
  readonly events: EventBusPort;
  readonly policy: PolicyEngine;
  readonly protectedOperations: ProtectedOperationPort;

  private readonly protectedOperationExecutor: ProtectedOperationExecutor;
  private readonly moduleRegistry = new ModuleRegistry();
  private readonly shutdownController = new AbortController();
  private lifecycle: CoreLifecycleState = "created";
  private readonly moduleStates = new Map<string, ModuleLifecycleState>();
  private initializedModules: CoreModule[] = [];
  private readonly cleanupInFlight = new Map<string, Promise<void>>();
  private readonly cleanupContext = new AsyncLocalStorage<CleanupExecutionContext>();
  private stopPromise: Promise<void> | undefined;
  private shutdownInitiated = false;
  private handlerDrainPromise: Promise<void> | undefined;
  private policyShutdownPromise: Promise<void> | undefined;
  private shutdownInitiationFailure: CoreError | undefined;
  private effectiveDrainDeadlineMs = 30_000;
  private readonly moduleMemory = new Map<string, GuardedMemoryPort>();

  constructor(private readonly options: CoreEngineOptions = {}) {
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
    this.validateShutdownConfiguration();
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

    try {
      this.validateShutdownConfiguration();
    } catch (error) {
      return Promise.reject(error);
    }

    // The lifecycle predicate closes admission before either shutdown path.
    if (this.lifecycle !== "stopping") this.lifecycle = "stopping";
    // Preserve the existing module-level shutdown signal and initiate both
    // protected-handler and policy shutdown in the same synchronous turn.
    this.shutdownController.abort("core_shutdown");
    if (!this.shutdownInitiated) {
      this.shutdownInitiated = true;
      try {
        this.handlerDrainPromise = this.protectedOperationExecutor.shutdown();
      } catch (error) {
        this.shutdownInitiationFailure = new CoreError(
          "PROTECTED_OPERATION_SHUTDOWN_FAILED",
          "Protected-operation shutdown initiation failed.",
          { cause: error }
        );
        this.handlerDrainPromise = Promise.resolve();
      }
      // Always attempt policy shutdown even if executor initiation failed.
      this.policyShutdownPromise = this.beginPolicyShutdown();
      void this.handlerDrainPromise.catch(() => undefined);
      void this.policyShutdownPromise.catch(() => undefined);
    }

    const handlerDrain = this.handlerDrainPromise ?? Promise.resolve();
    const policyShutdown = this.policyShutdownPromise ?? Promise.resolve();
    return this.installStopPromise(() => this.performStop(handlerDrain, policyShutdown));
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

  private beginPolicyShutdown(): Promise<void> {
    const recordFailure = (error: unknown): void => {
      const failure = new CoreError(
        "POLICY_SHUTDOWN_FAILED",
        "Policy shutdown initiation or completion failed.",
        { cause: error }
      );
      if (!this.shutdownInitiationFailure ||
          this.shutdownInitiationFailure.code === "PROTECTED_OPERATION_SHUTDOWN_FAILED") {
        this.shutdownInitiationFailure = failure;
      }
    };
    try {
      const shutdown = this.policy.shutdown?.() ?? Promise.resolve();
      return shutdown.catch((error: unknown) => {
        recordFailure(error);
        throw error;
      });
    } catch (error) {
      recordFailure(error);
      return Promise.reject(error);
    }
  }

  private validateShutdownConfiguration(): void {
    const configuration = this.options.protectedOperationShutdown;
    if (configuration === undefined) {
      this.effectiveDrainDeadlineMs = 30_000;
      return;
    }
    if (typeof configuration !== "object" || configuration === null) {
      throw new CoreError(
        "PROTECTED_OPERATION_SHUTDOWN_CONFIG_INVALID",
        "Protected-operation shutdown configuration is invalid."
      );
    }
    if (!Object.prototype.hasOwnProperty.call(configuration, "drainDeadlineMs")) {
      this.effectiveDrainDeadlineMs = 30_000;
      return;
    }
    const value: unknown = configuration.drainDeadlineMs;
    if (typeof value !== "number" || !Number.isInteger(value) ||
        value < 1 || value > 2_147_483_647) {
      throw new CoreError(
        "PROTECTED_OPERATION_SHUTDOWN_CONFIG_INVALID",
        "Protected-operation shutdown drainDeadlineMs must be an integer from 1 through 2147483647."
      );
    }
    this.effectiveDrainDeadlineMs = value;
  }

  private async performStop(
    handlerDrain: Promise<void>,
    policyShutdown: Promise<void>
  ): Promise<void> {
    if (this.shutdownInitiationFailure) throw this.shutdownInitiationFailure;

    const deadline = performance.now() + this.effectiveDrainDeadlineMs;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      const remaining = Math.max(0, deadline - performance.now());
      timeout = setTimeout(() => {
        const handlerBlocked = this.protectedOperationExecutor.activeInvocationCount > 0;
        reject(new CoreError(
          handlerBlocked ? "PROTECTED_OPERATION_DRAIN_TIMEOUT" : "POLICY_EVALUATION_DRAIN_TIMEOUT",
          handlerBlocked
            ? "Protected-operation handlers did not settle before the shutdown drain deadline."
            : "Policy shutdown did not settle before the shutdown drain deadline."
        ));
      }, remaining);
    });

    try {
      try {
        await Promise.race([Promise.all([handlerDrain, policyShutdown]), timeoutPromise]);
      } catch (error) {
        if (error instanceof CoreError &&
            (error.code === "PROTECTED_OPERATION_DRAIN_TIMEOUT" ||
             error.code === "POLICY_EVALUATION_DRAIN_TIMEOUT")) {
          throw error;
        }
        if (!this.shutdownInitiationFailure) {
          this.shutdownInitiationFailure = new CoreError(
            "POLICY_SHUTDOWN_FAILED",
            "Policy shutdown failed; module cleanup was not started.",
            { cause: error }
          );
        }
        throw this.shutdownInitiationFailure;
      }
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }

    if (this.shutdownInitiationFailure) throw this.shutdownInitiationFailure;

    // Timer delivery can be delayed by a busy event loop; the absolute
    // monotonic deadline is authoritative immediately before cleanup.
    if (performance.now() >= deadline) {
      const handlerBlocked = this.protectedOperationExecutor.activeInvocationCount > 0;
      throw new CoreError(
        handlerBlocked ? "PROTECTED_OPERATION_DRAIN_TIMEOUT" : "POLICY_EVALUATION_DRAIN_TIMEOUT",
        "Shutdown drain completed after its absolute monotonic deadline."
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
      shutdownSignal: this.shutdownController.signal,
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
