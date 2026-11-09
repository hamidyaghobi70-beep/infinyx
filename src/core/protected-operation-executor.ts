import type {
  PolicyEngine,
  PolicyRequest,
  ProtectedOperationCaller,
  ProtectedOperationContext,
  ProtectedOperationDefinition,
  ProtectedOperationHandle,
  ProtectedOperationPort,
  ProtectedOperationResult
} from "./contracts.js";
import { isValidPolicyDecision, isValidPolicyRequest } from "./fail-closed-policy-engine.js";

const handleBrand: unique symbol = Symbol("ProtectedOperationHandle");

interface InternalHandle extends ProtectedOperationHandle {
  readonly [handleBrand]: true;
}

interface RegisteredOperation<TInput = unknown, TOutput = unknown> {
  readonly id: string;
  readonly action: string;
  readonly resource: string;
  readonly validateInput: (value: unknown) => value is TInput;
  readonly handler: (
    input: TInput,
    context: ProtectedOperationContext
  ) => TOutput | Promise<TOutput>;
}

/**
 * Central authorization-and-execution boundary.
 *
 * Registration belongs to the composition root. Domain modules receive only
 * the execute-only ProtectedOperationPort, never the registered handler or
 * registration capability.
 */
export class ProtectedOperationExecutor implements ProtectedOperationPort {
  private readonly registrations = new WeakMap<object, RegisteredOperation>();
  private readonly operationIds = new Set<string>();
  private readonly usedRequests = new WeakMap<object, WeakSet<object>>();

  constructor(private readonly policy: PolicyEngine) {}

  register<TInput, TOutput>(
    definition: ProtectedOperationDefinition<TInput, TOutput>
  ): ProtectedOperationHandle<TInput, TOutput> {
    if (
      !definition ||
      typeof definition.id !== "string" ||
      !definition.id.trim() ||
      typeof definition.action !== "string" ||
      !definition.action.trim() ||
      typeof definition.resource !== "string" ||
      !definition.resource.trim() ||
      typeof definition.validateInput !== "function" ||
      typeof definition.handler !== "function"
    ) {
      throw new TypeError("Protected operation registration is invalid.");
    }

    if (this.operationIds.has(definition.id)) {
      throw new TypeError("Protected operation ID is already registered.");
    }

    const handle: InternalHandle = Object.freeze({
      id: definition.id,
      [handleBrand]: true
    });
    const registration: RegisteredOperation<TInput, TOutput> = Object.freeze({
      id: definition.id,
      action: definition.action,
      resource: definition.resource,
      validateInput: definition.validateInput,
      handler: definition.handler
    });
    this.registrations.set(handle, registration as RegisteredOperation);
    this.operationIds.add(definition.id);
    return handle;
  }

  async execute<TInput, TOutput>(
    operation: ProtectedOperationHandle<TInput, TOutput>,
    caller: ProtectedOperationCaller,
    input: TInput,
    options?: { readonly signal?: AbortSignal }
  ): Promise<ProtectedOperationResult<TOutput>> {
    const registration = operation && typeof operation === "object"
      ? this.registrations.get(operation as object) as RegisteredOperation<TInput, TOutput> | undefined
      : undefined;

    if (!registration) {
      return this.denied("Unknown or unregistered protected operation.");
    }
    if (!caller || typeof caller !== "object") {
      return this.denied("Protected operation caller request is invalid.");
    }

    let actorId: unknown;
    let callerContext: unknown;
    try {
      actorId = caller.actorId;
      callerContext = caller.context;
    } catch {
      return this.denied("Protected operation caller request could not be read.");
    }

    const policyRequestCandidate = {
      actorId,
      action: registration.action,
      resource: registration.resource,
      ...(callerContext === undefined ? {} : { context: callerContext })
    };
    if (!isValidPolicyRequest(policyRequestCandidate)) {
      return this.denied("Protected operation caller request is invalid.");
    }

    try {
      if (!registration.validateInput(input)) {
        return this.denied("Protected operation input is invalid.");
      }
    } catch {
      return this.denied("Protected operation input validation failed.");
    }

    const callerSignal = options?.signal;
    if (callerSignal?.aborted) {
      return this.denied("Protected operation was cancelled before authorization.");
    }

    let used = this.usedRequests.get(operation as object);
    if (!used) {
      used = new WeakSet<object>();
      this.usedRequests.set(operation as object, used);
    }
    if (used.has(caller as object)) {
      return this.denied("This request object has already been used for this operation.");
    }
    // Reserve synchronously before the first await so concurrent calls using
    // the same request object cannot both reach the handler.
    used.add(caller as object);

    const operationController = new AbortController();
    let callerAbortListener: (() => void) | undefined;
    if (callerSignal) {
      callerAbortListener = () => operationController.abort();
      callerSignal.addEventListener("abort", callerAbortListener, { once: true });
      if (callerSignal.aborted) operationController.abort();
    }

    try {
      if (operationController.signal.aborted) {
        return this.denied("Protected operation was cancelled before authorization.");
      }

      const policyRequest: PolicyRequest = policyRequestCandidate;

      let decision: unknown;
      try {
        decision = await this.policy.evaluate(policyRequest, {
          signal: operationController.signal
        });
      } catch {
        return this.denied("Policy evaluation failed; protected operation denied.");
      }

      // Re-check after the asynchronous policy boundary. No await is permitted
      // between this check and invoking the handler.
      if (operationController.signal.aborted) {
        return this.denied("Protected operation was cancelled during authorization.");
      }
      if (!isValidPolicyDecision(decision)) {
        return this.denied("Policy returned an invalid decision; protected operation denied.");
      }
      if ((decision as PolicyDecision).effect !== "allow") {
        return this.denied((decision as PolicyDecision).reason);
      }

      if (operationController.signal.aborted) {
        return this.denied("Protected operation was cancelled before execution.");
      }

      // Authorization is consumed in this call path; no reusable grant/token
      // is returned to callers or transferable to another operation.
      const value = await registration.handler(input, Object.freeze({
        operationId: registration.id,
        signal: operationController.signal
      }));
      return { status: "executed", value };
    } catch {
      return { status: "failed", reason: "Protected operation handler failed." };
    } finally {
      if (callerSignal && callerAbortListener) {
        callerSignal.removeEventListener("abort", callerAbortListener);
      }
    }
  }

  private denied<T>(reason: string): ProtectedOperationResult<T> {
    return { status: "denied", reason };
  }
}

