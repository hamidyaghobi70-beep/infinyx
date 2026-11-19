import { AsyncLocalStorage } from "node:async_hooks";
import { GuardedMemoryPort, revokeGuardedMemoryPort } from "./guarded-memory-port.js";
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
import { CoreError, type CoreErrorCode, type CoreShutdownBlocker, type CoreShutdownBlockerCode } from "./core-error.js";
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

function snapshotOptionRecord(
  value: unknown,
  allowedKeys: readonly string[],
  code: CoreErrorCode,
  message: string
): Record<string, unknown> {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("Invalid option record.");
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Option records must be plain objects.");
    }
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || !allowedKeys.includes(key)) {
        throw new Error("Unknown option property.");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor ||
          !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
          descriptor.enumerable !== true) {
        throw new Error("Option properties must be enumerable data properties.");
      }
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    throw new CoreError(code, message);
  }
}

function snapshotCoreEngineOptions(value: unknown): CoreEngineOptions {
  const options = snapshotOptionRecord(
    value,
    ["events", "policy", "memory", "policyTimeoutMs", "protectedOperationShutdown"],
    "CORE_ENGINE_OPTIONS_INVALID",
    "Core Engine options must contain only stable data properties."
  );
  const shutdown = options.protectedOperationShutdown;
  if (shutdown === undefined) {
    return Object.freeze(options) as CoreEngineOptions;
  }
  const shutdownOptions = snapshotOptionRecord(
    shutdown,
    ["drainDeadlineMs"],
    "PROTECTED_OPERATION_SHUTDOWN_CONFIG_INVALID",
    "Protected-operation shutdown configuration is invalid."
  );
  options.protectedOperationShutdown = Object.freeze(shutdownOptions);
  return Object.freeze(options) as CoreEngineOptions;
}

const MAX_PROTOTYPE_CHAIN_DEPTH = 64;

function captureEventBusMethod(
  target: object,
  name: "subscribe" | "publish" | "publishIfSubscribed" | "hasSubscribers",
  required: boolean
): Function | undefined {
  let current: object | null = target;
  const visited = new Set<object>();
  try {
    while (current !== null) {
      if (visited.has(current)) throw new TypeError("Invalid Event Bus prototype chain.");
      visited.add(current);
      const descriptor = Object.getOwnPropertyDescriptor(current, name);
      if (descriptor) {
        if (!Object.prototype.hasOwnProperty.call(descriptor, "value") ||
            typeof descriptor.value !== "function") {
          throw new TypeError("Event Bus methods must be data properties containing functions.");
        }
        return Function.prototype.bind.call(descriptor.value, target);
      }
      current = Object.getPrototypeOf(current);
    }
  } catch {
    throw new TypeError("Event Bus capability could not be safely inspected.");
  }
  if (required) throw new TypeError("Event Bus is missing required method: " + name + ".");
  return undefined;
}

function createEventBusCapability(value: unknown): EventBusPort {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    throw new TypeError("Event Bus capability must be an object.");
  }
  const target = value as object;
  const subscribe = captureEventBusMethod(target, "subscribe", true) as EventBusPort["subscribe"];
  const publish = captureEventBusMethod(target, "publish", true) as EventBusPort["publish"];
  const publishIfSubscribed = captureEventBusMethod(
    target, "publishIfSubscribed", false
  ) as EventBusPort["publishIfSubscribed"];
  const hasSubscribers = captureEventBusMethod(
    target, "hasSubscribers", false
  ) as EventBusPort["hasSubscribers"];

  const capability: EventBusPort = {
    subscribe: (type, handler) => subscribe(type, handler),
    publish: (type, payload) => publish(type, payload)
  };
  if (publishIfSubscribed) {
    capability.publishIfSubscribed = (type, payload) => publishIfSubscribed(type, payload);
  }
  if (hasSubscribers) {
    capability.hasSubscribers = (type) => hasSubscribers(type);
  }
  return Object.freeze(capability);
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
  /** Successful stop hooks are not repeated when a later memory drain needs retry. */
  private readonly moduleStopCompleted = new Set<string>();
  /** Stop hooks remain pinned while running past a deadline, so retries never invoke them twice. */
  private readonly moduleStopInFlight = new Map<string, Promise<void>>();
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
  private readonly options: CoreEngineOptions;

  constructor(options: CoreEngineOptions = {}) {
    this.options = snapshotCoreEngineOptions(options);
    const shutdownConfig = this.options.protectedOperationShutdown;
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
    this.events = createEventBusCapability(this.options.events ?? new InMemoryEventBus());
    this.policy = this.options.policy
      ? new FailClosedPolicyEngine(this.options.policy, this.options.policyTimeoutMs)
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
    const registered = this.moduleRegistry.register(module);
    this.moduleStates.set(registered.id, "registered");
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
      // Rollback is a shutdown path too: bound module memory draining with one
      // monotonic budget so a failed initialize/start cannot hang indefinitely.
      const rollbackDeadline = performance.now() + this.drainDeadlineMs;
      const cleanupErrors = await this.cleanupInitializedModules(
        failedModule ? new Set([failedModule]) : new Set(),
        rollbackDeadline
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
      // Startup rollback shares the same bounded memory-drain contract as initialization rollback.
      const rollbackDeadline = performance.now() + this.drainDeadlineMs;
      const cleanupErrors = await this.cleanupInitializedModules(
        failedModule ? new Set([failedModule]) : new Set(),
        rollbackDeadline
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

  }

  /** Retry a failed policy shutdown on a later stop() attempt, but share any in-flight attempt. */
  private beginPolicyShutdown(): void {
    if (this.policyShutdownPromise && !this.policyShutdownFailure) return;
    this.policyShutdownFailure = undefined;
    this.policyShutdownSettled = false;
    this.policyShutdownSettledAt = undefined;

    try {
      const shutdown = this.policy.shutdown?.();
      let attempt!: Promise<void>;
      attempt = Promise.resolve(shutdown).catch(() => {
        const failure = new CoreError(
          "POLICY_SHUTDOWN_FAILED",
          "Policy runtime shutdown failed."
        );
        if (this.policyShutdownPromise === attempt) {
          this.policyShutdownFailure = failure;
        }
        throw failure;
      }).finally(() => {
        // A settled attempt must never overwrite the state of a newer retry.
        if (this.policyShutdownPromise === attempt) {
          this.policyShutdownSettled = true;
          this.policyShutdownSettledAt = performance.now();
        }
      });
      this.policyShutdownPromise = attempt;
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
    this.beginPolicyShutdown();

    const executorDrain = this.executorDrainPromise ?? Promise.resolve();
    const policyShutdown = this.policyShutdownPromise ?? Promise.resolve();
    const remainingMs = Math.max(0, deadline - performance.now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), remainingMs);
    });

    try {
      const drained = Promise.allSettled([executorDrain, policyShutdown]);
      await Promise.race([drained, timedOut]);
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

    const errors = await this.cleanupInitializedModules(new Set(), deadline);
    if (errors.length === 0) {
      // Rollback may have completed a module's resource cleanup while preserving
      // its failed initialization/start state. A later successful shutdown is
      // the terminal lifecycle transition and must normalize those states.
      for (const [moduleId, state] of this.moduleStates) {
        if (state === "failed" && !this.initializedModules.some((module) => module.id === moduleId)) {
          this.moduleStates.set(moduleId, "stopped");
        }
      }
    }
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
      if (!(candidate instanceof GuardedMemoryPort)) {
        throw new CoreError(
          "INVALID_MEMORY_CAPABILITY",
          "Core Engine requires a GuardedMemoryPort bound to the receiving module."
        );
      }
      // Retain even a scope-mismatched capability before rejecting it so the
      // module rollback path can revoke and drain it. Revoke immediately to
      // prevent the rejected capability from admitting work in the meantime.
      memory = candidate;
      this.moduleMemory.set(moduleId, memory);
      if (candidate.scopeModuleId !== moduleId) {
        void revokeGuardedMemoryPort(candidate).catch(() => undefined);
        throw new CoreError(
          "INVALID_MEMORY_CAPABILITY",
          "Core Engine requires a GuardedMemoryPort bound to the receiving module."
        );
      }
    }
    return Object.freeze({ ...base, memory });
  }

  private async cleanupInitializedModules(
    preserveFailureIds: ReadonlySet<string> = new Set(),
    deadlineAt?: number
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
        await this.cleanupModule(module, preserveFailureIds.has(module.id), deadlineAt);
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  private async cleanupModule(module: CoreModule, preserveFailure: boolean, deadlineAt?: number): Promise<void> {
    const inFlight = this.cleanupInFlight.get(module.id);
    if (inFlight) {
      await inFlight;
      return;
    }
    const cleanup = (async (): Promise<void> => {
      this.moduleStates.set(module.id, "cleaning");
      const context: CleanupExecutionContext = { engine: this, active: true };
      try {
        if (!this.moduleStopCompleted.has(module.id)) {
          let stopWork = this.moduleStopInFlight.get(module.id);
          if (!stopWork) {
            if (deadlineAt !== undefined && performance.now() >= deadlineAt && module.stop) {
              throw new CoreError(
                "MODULE_STOP_TIMEOUT",
                "Module stop hook could not start before the shutdown deadline."
              );
            }
            const stopContext: CleanupExecutionContext = { engine: this, active: true };
            let trackedStopWork!: Promise<void>;
            trackedStopWork = this.cleanupContext.run(stopContext, async () => {
              try {
                await module.stop?.(this.createContext(module.id));
              } finally {
                // Keep re-entrant-stop protection active until the actual hook settles,
                // even if the caller's bounded wait has already timed out.
                stopContext.active = false;
              }
            }).then(() => {
              this.moduleStopCompleted.add(module.id);
              // Once the hook has actually settled, do not retain its completed
              // promise (and the module/context closure) for the engine lifetime.
              if (this.moduleStopInFlight.get(module.id) === trackedStopWork) {
                this.moduleStopInFlight.delete(module.id);
              }
            }, (error: unknown) => {
              if (this.moduleStopInFlight.get(module.id) === trackedStopWork) {
                this.moduleStopInFlight.delete(module.id);
              }
              throw error;
            });
            this.moduleStopInFlight.set(module.id, trackedStopWork);
            stopWork = trackedStopWork;
          }
          if (deadlineAt === undefined) {
            await stopWork;
          } else {
            const remainingMs = Math.max(0, deadlineAt - performance.now());
            let stopTimer: ReturnType<typeof setTimeout> | undefined;
            try {
              const timedOut = new Promise<false>((resolve) => {
                stopTimer = setTimeout(() => resolve(false), remainingMs);
              });
              const completed = await Promise.race([
                stopWork.then(() => true as const),
                timedOut
              ]);
              if (!completed) {
                throw new CoreError(
                  "MODULE_STOP_TIMEOUT",
                  "Module stop hook did not settle before the shutdown deadline."
                );
              }
            } finally {
              if (stopTimer !== undefined) clearTimeout(stopTimer);
            }
          }
        }
        const memory = this.moduleMemory.get(module.id);
        if (memory) {
          try {
            await revokeGuardedMemoryPort(memory, deadlineAt);
          } catch (cause) {
            if (deadlineAt !== undefined && performance.now() >= deadlineAt) {
              throw new CoreError(
                "MODULE_MEMORY_DRAIN_TIMEOUT",
                "Module memory operations did not drain before the shutdown deadline.",
                { cause }
              );
            }
            throw cause;
          }
        }
        this.moduleStates.set(module.id, preserveFailure ? "failed" : "stopped");
        // Release the module-scoped capability only after its cleanup succeeds.
        // Failed hooks retain it so an explicit cleanup retry sees the same context.
        this.moduleMemory.delete(module.id);
        this.moduleStopCompleted.delete(module.id);
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
