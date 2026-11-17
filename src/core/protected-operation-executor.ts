import { randomUUID } from "node:crypto";
import type {
  PolicyEngine,
  PolicyEvaluationOptions,
  PolicyRequest,
  ProtectedOperationCaller,
  ProtectedOperationContext,
  ProtectedOperationDefinition,
  ProtectedOperationHandle,
  ProtectedOperationPort,
  ProtectedOperationResult
} from "./contracts.js";
import { isValidPolicyDecision, isValidPolicyRequest } from "./fail-closed-policy-engine.js";
import { snapshotBoundedPolicyData } from "./policy-input-snapshot.js";

const handleBrand: unique symbol = Symbol("ProtectedOperationHandle");

interface InternalHandle extends ProtectedOperationHandle {
  readonly [handleBrand]: true;
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
type ActiveExecutionPhase = "AUTHORIZING" | "RUNNING";

interface ActiveExecution {
  readonly controller: AbortController;
  phase: ActiveExecutionPhase;
}

export class ProtectedOperationExecutor implements ProtectedOperationPort {
  private readonly registrations = new WeakMap<object, RegisteredOperation>();
  private readonly operationIds = new Set<string>();
  private readonly activeExecutions = new Map<string, ActiveExecution>();
  private admissionOpen = true;
  // This is in-memory, per-process object-identity duplicate suppression only.
  // It is not durable replay protection and does not provide exactly-once semantics.
  private readonly usedRequests = new WeakMap<object, WeakSet<object>>();

  constructor(
    private readonly policy: PolicyEngine,
    private readonly isCoreReady: () => boolean
  ) {}

  /** Close admission synchronously and cooperatively cancel every accepted execution. */
  closeAdmission(): void {
    if (!this.admissionOpen) return;
    this.admissionOpen = false;
    for (const execution of this.activeExecutions.values()) {
      if (!execution.controller.signal.aborted) {
        execution.controller.abort("protected_operation_admission_closed");
      }
    }
  }

  /** Number of accepted executions that have not actually settled yet. */
  get activeExecutionCount(): number {
    return this.activeExecutions.size;
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
    if (!this.admissionOpen || !this.isCoreReady()) {
      return this.denied("Protected operation admission is closed or Core Engine is not running.");
    }
    const registration = operation && typeof operation === "object"
      ? this.registrations.get(operation as object) as RegisteredOperation<TInput, TOutput> | undefined
      : undefined;
    if (!registration) return this.denied("Unknown or unregistered protected operation.");
    if (!caller || typeof caller !== "object") return this.denied("Protected operation caller request is invalid.");

    let actorId: unknown;
    let callerContext: unknown;
    try {
      actorId = caller.actorId;
      callerContext = caller.context;
    } catch {
      return this.denied("Protected operation caller request could not be read.");
    }

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

    // Admission and registry insertion are synchronous: closeAdmission() cannot
    // interleave between the final gate and registration on this JS execution turn.
    if (!this.admissionOpen || !this.isCoreReady()) {
      return this.denied("Protected operation admission is closed or Core Engine is stopping.");
    }
    const executionId = randomUUID();
    const operationController = new AbortController();
    const activeExecution: ActiveExecution = { controller: operationController, phase: "AUTHORIZING" };
    this.activeExecutions.set(executionId, activeExecution);
    let callerAbortListener: (() => void) | undefined;
    let parentAbortListener: (() => void) | undefined;
    try {
      if (callerSignal) {
        callerAbortListener = () => operationController.abort();
        callerSignal.addEventListener("abort", callerAbortListener, { once: true });
        if (callerSignal.aborted) operationController.abort();
      }
      if (parentSignal) {
        parentAbortListener = () => operationController.abort();
        parentSignal.addEventListener("abort", parentAbortListener, { once: true });
        if (parentSignal.aborted) operationController.abort();
      }

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
      if (!this.isCoreReady()) return this.denied("Core Engine is stopping; protected operation denied.");
      if (operationController.signal.aborted) return this.denied("Protected operation was cancelled during authorization.");
      if (!isValidPolicyDecision(decision)) return this.denied("Policy returned an invalid decision; protected operation denied.");
      if (decision.effect !== "allow") return this.denied(decision.reason);
      if (!this.isCoreReady()) return this.denied("Core Engine is stopping; protected operation denied.");

      activeExecution.phase = "RUNNING";
      const value = await registration.handler(inputSnapshot as TInput, Object.freeze({
        operationId: executionId,
        registrationId: registration.id,
        signal: operationController.signal
      }));
      return { status: "executed", value };
    } catch {
      return { status: "failed", reason: "Protected operation handler failed." };
    } finally {
      if (callerSignal && callerAbortListener) callerSignal.removeEventListener("abort", callerAbortListener);
      if (parentSignal && parentAbortListener) parentSignal.removeEventListener("abort", parentAbortListener);
      this.activeExecutions.delete(executionId);
    }
  }

  private denied<T>(reason: string): ProtectedOperationResult<T> {
    return { status: "denied", reason };
  }
}
