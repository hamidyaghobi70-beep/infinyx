import { randomUUID } from "node:crypto";
import type {
  PolicyEngine,
  PolicyEvaluationOptions,
  PolicyRequest,
  ProtectedOperationCaller,
  ProtectedOperationContext,
  ProtectedOperationChildContext,
  ProtectedOperationDefinition,
  ProtectedOperationHandle,
  ProtectedOperationPort,
  ProtectedOperationResult
} from "./contracts.js";
import { isValidPolicyRequest, snapshotPolicyDecision } from "./fail-closed-policy-engine.js";
import { snapshotBoundedPolicyData } from "./policy-input-snapshot.js";

const handleBrand: unique symbol = Symbol("ProtectedOperationHandle");

interface InternalHandle extends ProtectedOperationHandle {
  readonly [handleBrand]: true;
}

interface ActiveHandler {
  readonly controller: AbortController;
  readonly settled: Promise<void>;
  readonly settle: () => void;
  pendingChildren: number;
  handlerSettled: boolean;
  childFailed: boolean;
}

interface ChildActivityScope {
  open: boolean;
}

function settleHandlerIfComplete(active: ActiveHandler): void {
  if (active.handlerSettled && active.pendingChildren === 0) active.settle();
}

/**
 * Each child is registered before its callback is invoked. A child scope remains
 * open until its own task settles, allowing tracked descendants but not late work.
 */
function createChildActivityContext(
  active: ActiveHandler,
  scope: ChildActivityScope
): ProtectedOperationChildContext {
  const runChild = <T>(
    start: (context: ProtectedOperationChildContext) => T | Promise<T>
  ): Promise<T> => {
    if (!scope.open) {
      const rejected = Promise.reject<T>(new Error("Child activity scope is already closed."));
      void rejected.catch(() => undefined);
      return rejected;
    }

    active.pendingChildren += 1;
    const childScope: ChildActivityScope = { open: true };
    let started: T | Promise<T>;
    try {
      started = start(createChildActivityContext(active, childScope));
    } catch (error) {
      childScope.open = false;
      active.childFailed = true;
      active.pendingChildren -= 1;
      settleHandlerIfComplete(active);
      return Promise.reject(error);
    }

    const tracked = Promise.resolve(started).then(
      (value) => {
        childScope.open = false;
        active.pendingChildren -= 1;
        settleHandlerIfComplete(active);
        return value;
      },
      (error: unknown) => {
        childScope.open = false;
        active.childFailed = true;
        active.pendingChildren -= 1;
        settleHandlerIfComplete(active);
        throw error;
      }
    );
    // Observe detached rejections internally while preserving the caller's promise.
    void tracked.catch(() => undefined);
    return tracked;
  };

  return Object.freeze({ runChild });
}

interface RegisteredOperation<TInput = unknown, TOutput = unknown> {
  readonly id: string;
  readonly action: string;
  readonly resource: string;
  readonly validateInput: (value: unknown) => value is TInput;
  readonly handler: (input: TInput, context: ProtectedOperationContext) => TOutput | Promise<TOutput>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Create a bounded, detached and immutable Policy Context snapshot. */
function snapshotPolicyContext(value: unknown): PolicyRequest["context"] | undefined {
  const result = snapshotBoundedPolicyData(value);
  if (!result.ok) throw new TypeError("Policy context snapshot failed.");
  if (result.value === undefined) return undefined;
  if (!isPlainRecord(result.value)) throw new TypeError("Policy context must be a plain object.");
  return result.value as PolicyRequest["context"];
}

/**
 * Central authorization-and-execution boundary. The lifecycle predicate is
 * owned by CoreEngine; only a running Core may admit protected operations.
 */
export class ProtectedOperationExecutor implements ProtectedOperationPort {
  private readonly registrations = new WeakMap<object, RegisteredOperation>();
  private readonly operationIds = new Set<string>();
  // This is in-memory, per-process object-identity duplicate suppression only.
  // It is not durable replay protection and does not provide exactly-once semantics.
  private readonly usedRequests = new WeakMap<object, WeakSet<object>>();
  private readonly activeHandlers = new Map<string, ActiveHandler>();
  private admissionClosed = false;

  constructor(
    private readonly policy: PolicyEngine,
    private readonly isCoreReady: () => boolean
  ) {}

  get activeHandlerCount(): number {
    return this.activeHandlers.size;
  }

  /** Close the admission boundary synchronously and request cooperative cancellation. */
  closeAdmission(): void {
    this.admissionClosed = true;
    for (const active of this.activeHandlers.values()) {
      if (!active.controller.signal.aborted) {
        active.controller.abort({
          code: "RUNTIME_SHUTDOWN",
          message: "Runtime shutdown requested protected-operation cancellation."
        });
      }
    }
  }

  /** Observe actual handler settlement; this method never cancels or replays handlers. */
  async drain(): Promise<void> {
    while (this.activeHandlers.size > 0) {
      const pending = [...this.activeHandlers.values()].map((active) => active.settled);
      await Promise.all(pending);
    }
  }

  register<TInput, TOutput>(definition: ProtectedOperationDefinition<TInput, TOutput>): ProtectedOperationHandle<TInput, TOutput> {
    if (!definition || typeof definition.id !== "string" || !definition.id.trim() ||
      typeof definition.action !== "string" || !definition.action.trim() ||
      typeof definition.resource !== "string" || !definition.resource.trim() ||
      typeof definition.validateInput !== "function" || typeof definition.handler !== "function") {
      throw new TypeError("Protected operation registration is invalid.");
    }
    if (this.operationIds.has(definition.id)) throw new TypeError("Protected operation ID is already registered.");
    const handle: InternalHandle = Object.freeze({ id: definition.id, [handleBrand]: true as const });
    const registration: RegisteredOperation<TInput, TOutput> = Object.freeze({
      id: definition.id, action: definition.action, resource: definition.resource,
      validateInput: definition.validateInput, handler: definition.handler
    });
    this.registrations.set(handle, registration as RegisteredOperation);
    this.operationIds.add(definition.id);
    return handle;
  }

  async execute<TInput, TOutput>(
    operation: ProtectedOperationHandle<TInput, TOutput>,
    caller: ProtectedOperationCaller,
    input: TInput,
    options?: PolicyEvaluationOptions
  ): Promise<ProtectedOperationResult<TOutput>> {
    if (!this.isCoreReady() || this.admissionClosed) return this.denied("Core Engine is not running; protected operation denied.");
    const registration = operation && typeof operation === "object"
      ? this.registrations.get(operation as object) as RegisteredOperation<TInput, TOutput> | undefined
      : undefined;
    if (!registration) return this.denied("Unknown or unregistered protected operation.");
    if (!caller || typeof caller !== "object") return this.denied("Protected operation caller request is invalid.");

    const callerSnapshotResult = snapshotBoundedPolicyData(caller);
    if (!callerSnapshotResult.ok || !isPlainRecord(callerSnapshotResult.value)) {
      return this.denied("Protected operation caller request could not be safely snapshotted.");
    }
    const callerSnapshot = callerSnapshotResult.value as Record<string, unknown>;
    const actorId = callerSnapshot.actorId;
    const callerContext = callerSnapshot.context;

    let snapshot: PolicyRequest["context"] | undefined;
    try {
      snapshot = snapshotPolicyContext(callerContext);
    } catch {
      return this.denied("Protected operation policy context is invalid or non-cloneable.");
    }
    const policyRequestCandidate = {
      actorId, action: registration.action, resource: registration.resource,
      ...(snapshot === undefined ? {} : { context: snapshot })
    };
    if (!isValidPolicyRequest(policyRequestCandidate)) return this.denied("Protected operation caller request is invalid.");

    const inputSnapshotResult = snapshotBoundedPolicyData(input);
    if (!inputSnapshotResult.ok) {
      return this.denied("Protected operation input could not be safely snapshotted.");
    }
    const inputSnapshot = inputSnapshotResult.value;

    try {
      if (!registration.validateInput(inputSnapshot)) return this.denied("Protected operation input is invalid.");
    } catch {
      return this.denied("Protected operation input validation failed.");
    }

    const callerSignal = options?.signal;
    const parentSignal = options?.parentSignal;
    if (callerSignal?.aborted || parentSignal?.aborted) {
      return this.denied("Protected operation was cancelled before authorization.");
    }

    let used = this.usedRequests.get(operation as object);
    if (!used) { used = new WeakSet<object>(); this.usedRequests.set(operation as object, used); }
    if (used.has(caller as object)) return this.denied("This request object has already been used for this operation.");
    // Reservation is synchronous. A new object identity is a distinct in-memory request.
    used.add(caller as object);

    const operationController = new AbortController();
    let callerAbortListener: (() => void) | undefined;
    let parentAbortListener: (() => void) | undefined;
    if (callerSignal) {
      callerAbortListener = () => operationController.abort({
        code: "CALLER_CANCELLED",
        message: "Protected operation cancellation requested by caller."
      });
      callerSignal.addEventListener("abort", callerAbortListener, { once: true });
      if (callerSignal.aborted) callerAbortListener();
    }
    if (parentSignal) {
      parentAbortListener = () => operationController.abort({
        code: "PARENT_CANCELLED",
        message: "Protected operation cancellation requested by parent."
      });
      parentSignal.addEventListener("abort", parentAbortListener, { once: true });
      if (parentSignal.aborted) parentAbortListener();
    }

    try {
      if (!this.isCoreReady()) return this.denied("Core Engine is stopping or not running; protected operation denied.");
      if (operationController.signal.aborted) return this.denied("Protected operation was cancelled before authorization.");

      let decision: unknown;
      try {
        decision = await this.policy.evaluate(policyRequestCandidate, {
          signal: operationController.signal,
          ...(options?.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt })
        });
      } catch {
        return this.denied("Policy evaluation failed; protected operation denied.");
      }

      // Recheck lifecycle and cancellation immediately before handler admission;
      // there is no await between these checks and invoking the handler.
      if (!this.isCoreReady() || this.admissionClosed) return this.denied("Core Engine is stopping; protected operation denied.");
      if (operationController.signal.aborted) return this.denied("Protected operation was cancelled during authorization.");
      const safeDecision = snapshotPolicyDecision(decision);
      if (!safeDecision) return this.denied("Policy returned an invalid decision; protected operation denied.");
      if (safeDecision.effect !== "allow") return this.denied(safeDecision.reason);
      if (!this.isCoreReady() || this.admissionClosed) return this.denied("Core Engine is stopping; protected operation denied.");

      const operationId = randomUUID();
      let settle!: () => void;
      const settled = new Promise<void>((resolve) => { settle = resolve; });
      const active: ActiveHandler = {
        controller: operationController,
        settled,
        settle,
        pendingChildren: 0,
        handlerSettled: false,
        childFailed: false
      };
      this.activeHandlers.set(operationId, active);
      const rootScope: ChildActivityScope = { open: true };
      let value: TOutput | undefined;
      let handlerFailed = false;
      try {
        // Register before invoking user code; no await separates the final gate,
        // registry insertion, and handler invocation.
        try {
          value = await registration.handler(inputSnapshot as TInput, Object.freeze({
            operationId,
            signal: operationController.signal,
            ...createChildActivityContext(active, rootScope)
          }));
        } catch {
          handlerFailed = true;
        } finally {
          // The root scope closes when the handler settles. Already registered
          // children may finish and register descendants within their own scopes.
          rootScope.open = false;
          active.handlerSettled = true;
          settleHandlerIfComplete(active);
        }

        await active.settled;
        if (handlerFailed || active.childFailed) {
          return { status: "failed", reason: "Protected operation handler or child activity failed." };
        }
        return { status: "executed", value: value as TOutput };
      } finally {
        this.activeHandlers.delete(operationId);
      }
    } catch {
      return { status: "failed", reason: "Protected operation handler failed." };
    } finally {
      if (callerSignal && callerAbortListener) callerSignal.removeEventListener("abort", callerAbortListener);
      if (parentSignal && parentAbortListener) parentSignal.removeEventListener("abort", parentAbortListener);
    }
  }

  private denied<T>(reason: string): ProtectedOperationResult<T> {
    return { status: "denied", reason };
  }
}
