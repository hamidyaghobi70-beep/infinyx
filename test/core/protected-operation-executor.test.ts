import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreEngine } from "../../src/core/core-engine.js";
import { ProtectedOperationExecutor } from "../../src/core/protected-operation-executor.js";
import type {
  PolicyDecision,
  PolicyRequest,
  ProtectedOperationHandle
} from "../../src/core/contracts.js";

const caller = { actorId: "caller-1" };
const allow: PolicyDecision = { effect: "allow", reason: "explicit grant" };
const deny: PolicyDecision = { effect: "deny", reason: "explicit denial" };

function isRecordInput(value: unknown): value is { readonly value: string } {
  return typeof value === "object" && value !== null &&
    "value" in value && typeof value.value === "string";
}

function makeEngine(
  evaluate: (request: PolicyRequest, options?: { readonly signal?: AbortSignal }) => Promise<PolicyDecision> =
    async () => allow
) {
  const engine = new CoreEngine({ policy: { evaluate } });
  const handler = vi.fn(async (input: { readonly value: string }) => input.value.toUpperCase());
  const operation = engine.registerProtectedOperation({
    id: "records.read",
    action: "record.read",
    resource: "record:fixed",
    validateInput: isRecordInput,
    handler
  });
  return { engine, operation, handler };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const startedEngines = new WeakMap<CoreEngine, Promise<void>>();
async function ensureStarted(engine: CoreEngine): Promise<void> {
  if (engine.state === "running") return;
  let pending = startedEngines.get(engine);
  if (!pending) {
    pending = (async () => { await engine.initialize(); await engine.start(); })();
    startedEngines.set(engine, pending);
  }
  await pending;
}


describe("ProtectedOperationExecutor", () => {
  it("closes admission synchronously and prevents an in-flight authorization from starting its handler", async () => {
    let resolvePolicy!: (decision: PolicyDecision) => void;
    let policySignal: AbortSignal | undefined;
    const evaluator = vi.fn((_request: PolicyRequest, options?: { readonly signal?: AbortSignal }) => {
      policySignal = options?.signal;
      return new Promise<PolicyDecision>((resolve) => { resolvePolicy = resolve; });
    });
    const executor = new ProtectedOperationExecutor({ evaluate: evaluator }, () => true);
    const handler = vi.fn(() => "must-not-run");
    const operation = executor.register({
      id: "lifecycle.admission-policy",
      action: "record.read",
      resource: "record:admission",
      validateInput: (value: unknown): value is string => typeof value === "string",
      handler
    });

    const pending = executor.execute(operation, { actorId: "admission-policy" }, "input");
    await Promise.resolve();
    expect(executor.activeExecutionCount).toBe(1);

    executor.closeAdmission();
    expect(policySignal?.aborted).toBe(true);
    expect(executor.activeExecutionCount).toBe(1);

    resolvePolicy(allow);
    const result = await pending;
    expect(result).toMatchObject({ status: "denied" });
    expect(handler).not.toHaveBeenCalled();
    expect(executor.activeExecutionCount).toBe(0);

    const callsBeforeRejectedAdmission = evaluator.mock.calls.length;
    const afterClose = await executor.execute(operation, { actorId: "after-close" }, "input");
    expect(afterClose).toMatchObject({ status: "denied" });
    expect(evaluator).toHaveBeenCalledTimes(callsBeforeRejectedAdmission);
  });

  it("removes an admitted execution if abort-listener registration throws", async () => {
    const executor = new ProtectedOperationExecutor({ evaluate: async () => allow }, () => true);
    const handler = vi.fn(() => "must-not-run");
    const operation = executor.register({
      id: "lifecycle.abort-listener-failure",
      action: "record.read",
      resource: "record:abort-listener",
      validateInput: (value: unknown): value is string => typeof value === "string",
      handler
    });
    const invalidSignal = {
      aborted: false,
      addEventListener: () => { throw new Error("listener registration failed"); },
      removeEventListener: () => undefined
    } as unknown as AbortSignal;

    const result = await executor.execute(
      operation, { actorId: "abort-listener-failure" }, "input", { signal: invalidSignal }
    );

    expect(result).toMatchObject({ status: "failed" });
    expect(executor.activeExecutionCount).toBe(0);
    expect(handler).not.toHaveBeenCalled();
  });

  it("keeps a running handler registered until its promise actually settles after cancellation", async () => {
    let resolveHandler!: (value: string) => void;
    let handlerSignal: AbortSignal | undefined;
    const executor = new ProtectedOperationExecutor({ evaluate: async () => allow }, () => true);
    const operation = executor.register({
      id: "lifecycle.admission-handler",
      action: "record.read",
      resource: "record:handler",
      validateInput: (value: unknown): value is string => typeof value === "string",
      handler: (_input, context) => {
        handlerSignal = context.signal;
        return new Promise<string>((resolve) => { resolveHandler = resolve; });
      }
    });

    const pending = executor.execute(operation, { actorId: "admission-handler" }, "input");
    await Promise.resolve();
    await Promise.resolve();
    expect(executor.activeExecutionCount).toBe(1);
    expect(handlerSignal).toBeDefined();

    executor.closeAdmission();
    expect(handlerSignal?.aborted).toBe(true);
    expect(executor.activeExecutionCount).toBe(1);

    resolveHandler("settled");
    await expect(pending).resolves.toEqual({ status: "executed", value: "settled" });
    expect(executor.activeExecutionCount).toBe(0);
  });


  it("executes a handler only after a valid Allow decision", async () => {
    const { engine, operation, handler } = makeEngine();
    await ensureStarted(engine);
    const result = await engine.protectedOperations.execute(operation, caller, { value: "ok" });
    expect(result).toEqual({ status: "executed", value: "OK" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("assigns a unique UUID to each execution while preserving the registration ID", async () => {
    const executionIds: string[] = [];
    const registrationIds: string[] = [];
    const engine = new CoreEngine({ policy: { evaluate: async () => allow } });
    const operation = engine.registerProtectedOperation({
      id: "records.execution-identity",
      action: "record.read",
      resource: "record:identity",
      validateInput: (value: unknown): value is string => typeof value === "string",
      handler: (_input, context) => {
        executionIds.push(context.operationId);
        registrationIds.push(context.registrationId);
        return "ok";
      }
    });
    await ensureStarted(engine);

    const results = await Promise.all([
      engine.protectedOperations.execute(operation, { actorId: "identity-a" }, "a"),
      engine.protectedOperations.execute(operation, { actorId: "identity-b" }, "b"),
      engine.protectedOperations.execute(operation, { actorId: "identity-c" }, "c")
    ]);

    expect(results).toHaveLength(3);
    expect(results.every((result) => result.status === "executed")).toBe(true);
    expect(new Set(executionIds).size).toBe(3);
    expect(executionIds).not.toContain("records.execution-identity");
    expect(executionIds).toEqual(expect.arrayContaining([
      expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
      expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
      expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    ]));
    expect(registrationIds).toEqual([
      "records.execution-identity",
      "records.execution-identity",
      "records.execution-identity"
    ]);
  });

  it("never invokes a handler after Deny", async () => {
    const { engine, operation, handler } = makeEngine(async () => deny);
    await ensureStarted(engine);
    const result = await engine.protectedOperations.execute(operation, caller, { value: "no" });
    expect(result).toMatchObject({ status: "denied" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("converts policy errors into denial without invoking the handler", async () => {
    const { engine, operation, handler } = makeEngine(async () => {
      throw new Error("policy unavailable");
    });
    await ensureStarted(engine);
    const result = await engine.protectedOperations.execute(operation, caller, { value: "no" });
    expect(result).toMatchObject({ status: "denied" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects invalid policy decisions", async () => {
    const { engine, operation, handler } = makeEngine(async () => ({
      effect: "permit",
      reason: "not an Allow/Deny decision"
    } as unknown as PolicyDecision));
    await ensureStarted(engine);
    const result = await engine.protectedOperations.execute(operation, caller, { value: "no" });
    expect(result).toMatchObject({ status: "denied" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not invoke a handler when the caller is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const { engine, operation, handler } = makeEngine();
    await ensureStarted(engine);
    const result = await engine.protectedOperations.execute(
      operation, caller, { value: "no" }, { signal: controller.signal }
    );
    expect(result).toMatchObject({ status: "denied" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("cancels an in-flight policy evaluation and does not invoke the handler", async () => {
    const controller = new AbortController();
    let evaluatorSignal: AbortSignal | undefined;
    const { engine, operation, handler } = makeEngine((_request, options) => {
      evaluatorSignal = options?.signal;
      return new Promise<PolicyDecision>(() => undefined);
    });
    await ensureStarted(engine);
    const pending = engine.protectedOperations.execute(
      operation, caller, { value: "no" }, { signal: controller.signal }
    );
    await Promise.resolve();
    controller.abort();
    const result = await pending;
    expect(result).toMatchObject({ status: "denied" });
    expect(evaluatorSignal?.aborted).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it("denies on policy timeout and aborts the evaluator signal", async () => {
    vi.useFakeTimers();
    let evaluatorSignal: AbortSignal | undefined;
    const policy = {
      evaluate: (_request: PolicyRequest, options?: { readonly signal?: AbortSignal }) => {
        evaluatorSignal = options?.signal;
        return new Promise<PolicyDecision>(() => undefined);
      }
    };
    const engine = new CoreEngine({ policy, policyTimeoutMs: 20 });
    const handler = vi.fn(async () => "should-not-run");
    const operation = engine.registerProtectedOperation({
      id: "records.timeout",
      action: "record.read",
      resource: "record:timeout",
      validateInput: (value: unknown): value is string => typeof value === "string",
      handler
    });
    await ensureStarted(engine);
    const pending = engine.protectedOperations.execute(operation, caller, "x");
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(20);
    expect(await pending).toMatchObject({ status: "denied" });
    expect(evaluatorSignal?.aborted).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("validates input before policy evaluation and handler execution", async () => {
    const evaluator = vi.fn(async () => allow);
    const { engine, operation, handler } = makeEngine(evaluator);
    await ensureStarted(engine);
    const result = await engine.protectedOperations.execute(operation, caller, { value: 7 } as never);
    expect(result).toMatchObject({ status: "denied" });
    expect(evaluator).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("binds the policy decision to the registered operation identity", async () => {
    let observed: PolicyRequest | undefined;
    const { engine, operation, handler } = makeEngine(async (request) => {
      observed = request;
      return allow;
    });
    await ensureStarted(engine);
    await engine.protectedOperations.execute(operation, {
      actorId: "caller-1",
      context: { attributes: { requestedAction: "admin.delete" } }
    }, { value: "ok" });
    expect(observed?.action).toBe("record.read");
    expect(observed?.resource).toBe("record:fixed");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("rejects forged or cross-executor operation handles", async () => {
    const first = makeEngine();
    const second = makeEngine();
    await ensureStarted(second.engine);
    const result = await second.engine.protectedOperations.execute(
      first.operation as ProtectedOperationHandle<{ readonly value: string }, string>,
      caller,
      { value: "no" }
    );
    expect(result).toMatchObject({ status: "denied" });
    expect(second.handler).not.toHaveBeenCalled();
  });

  it("prevents concurrent duplicate execution with the same request object", async () => {
    let release!: (decision: PolicyDecision) => void;
    const { engine, operation, handler } = makeEngine(() =>
      new Promise<PolicyDecision>((resolve) => { release = resolve; })
    );
    const sameCaller = { actorId: "caller-duplicate" };
    await ensureStarted(engine);
    const first = engine.protectedOperations.execute(operation, sameCaller, { value: "one" });
    await ensureStarted(engine);
    const second = await engine.protectedOperations.execute(operation, sameCaller, { value: "two" });
    expect(second).toMatchObject({ status: "denied" });
    release(allow);
    expect(await first).toEqual({ status: "executed", value: "ONE" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not expose registration or handler references through the module port", async () => {
    const { engine } = makeEngine();
    expect("register" in engine.protectedOperations).toBe(false);
    expect("registerProtectedOperation" in engine.protectedOperations).toBe(false);
  });

  it("passes a cancellation signal to the handler after authorization", async () => {
    let handlerSignal: AbortSignal | undefined;
    const engine = new CoreEngine({ policy: { evaluate: async () => allow } });
    const operation = engine.registerProtectedOperation({
      id: "records.signal",
      action: "record.read",
      resource: "record:signal",
      validateInput: (value: unknown): value is string => typeof value === "string",
      handler: (_input, context) => {
        handlerSignal = context.signal;
        return "ok";
      }
    });
    const controller = new AbortController();
    await ensureStarted(engine);
    await engine.protectedOperations.execute(operation, caller, "x", { signal: controller.signal });
    expect(handlerSignal).toBeInstanceOf(AbortSignal);
    expect(handlerSignal?.aborted).toBe(false);
  });


  it("rejects duplicate operation identifiers at registration", () => {
    const { engine } = makeEngine();
    expect(() => engine.registerProtectedOperation({
      id: "records.read",
      action: "record.write",
      resource: "record:other",
      validateInput: isRecordInput,
      handler: async (input) => input.value
    })).toThrow(/already registered/);
  });

  it("denies when the caller cancels after Allow resolves but before handler admission", async () => {
    const controller = new AbortController();
    const { engine, operation, handler } = makeEngine(async () => {
      controller.abort();
      return allow;
    });
    await ensureStarted(engine);
    const result = await engine.protectedOperations.execute(
      operation, caller, { value: "no" }, { signal: controller.signal }
    );
    expect(result).toMatchObject({ status: "denied" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("provides modules with only the central execute-only port", async () => {
    const { engine } = makeEngine();
    let modulePort: unknown;
    engine.register({
      id: "domain",
      version: "1.0.0",
      initialize: (context) => { modulePort = context.protectedOperations; }
    });
    await engine.initialize();
    expect(modulePort).toBe(engine.protectedOperations);
    expect(modulePort).not.toHaveProperty("register");
    expect(modulePort).not.toHaveProperty("registerProtectedOperation");
  });

  it("reports handler failure without turning it into an authorization grant", async () => {
    const engine = new CoreEngine({ policy: { evaluate: async () => allow } });
    const handler = vi.fn(() => { throw new Error("handler failed"); });
    const operation = engine.registerProtectedOperation({
      id: "records.failure",
      action: "record.write",
      resource: "record:failure",
      validateInput: (value: unknown): value is string => typeof value === "string",
      handler
    });
    await ensureStarted(engine);
    const result = await engine.protectedOperations.execute(operation, caller, "x");
    expect(result).toMatchObject({ status: "failed" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("rejects protected operations until CoreEngine is running", async () => {
    const { engine, operation, handler } = makeEngine();
    const result = await engine.protectedOperations.execute(operation, caller, { value: "early" });
    expect(result).toMatchObject({ status: "denied" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not expose PolicyEngine through ModuleContext", async () => {
    const { engine } = makeEngine();
    let context: unknown;
    engine.register({ id: "policy-isolation", version: "1.0.0", initialize: (ctx) => { context = ctx; } });
    await engine.initialize();
    expect(context).not.toHaveProperty("policy");
    expect(context).toHaveProperty("protectedOperations");
  });

  it("denies an in-flight policy result if shutdown begins before handler admission", async () => {
    let release!: (decision: PolicyDecision) => void;
    const { engine, operation, handler } = makeEngine(() =>
      new Promise<PolicyDecision>((resolve) => { release = resolve; })
    );
    await ensureStarted(engine);
    const pending = engine.protectedOperations.execute(operation, { actorId: "race" }, { value: "x" });
    await Promise.resolve();
    const stopping = engine.stop();
    release(allow);
    expect(await pending).toMatchObject({ status: "denied" });
    expect(handler).not.toHaveBeenCalled();
    await stopping;
  });

  it("passes a detached deeply frozen context snapshot to asynchronous policy", async () => {
    let release!: (decision: PolicyDecision) => void;
    let observed: PolicyRequest | undefined;
    const { engine, operation } = makeEngine(async (request) => {
      observed = request;
      return new Promise<PolicyDecision>((resolve) => { release = resolve; });
    });
    await ensureStarted(engine);
    const attributes = { nested: { label: "before" } };
    const mutableCaller = { actorId: "snapshot", context: { attributes } };
    await ensureStarted(engine);
    const pending = engine.protectedOperations.execute(operation, mutableCaller, { value: "ok" });
    await Promise.resolve();
    attributes.nested.label = "after";
    release(allow);
    await pending;
    expect(observed?.context?.attributes?.nested).toEqual({ label: "before" });
    expect(Object.isFrozen(observed?.context)).toBe(true);
    expect(Object.isFrozen(observed?.context?.attributes)).toBe(true);
    expect(Object.isFrozen(observed?.context?.attributes?.nested)).toBe(true);
  });

  it("fails closed for cyclic policy context before calling PolicyEngine", async () => {
    const evaluator = vi.fn(async () => allow);
    const { engine, operation, handler } = makeEngine(evaluator);
    await ensureStarted(engine);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await ensureStarted(engine);
    const result = await engine.protectedOperations.execute(
      operation, { actorId: "cycle", context: { attributes: cyclic } }, { value: "x" }
    );
    expect(result).toMatchObject({ status: "denied" });
    expect(evaluator).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("documents identity-only duplicate suppression: a new caller object is distinct", async () => {
    const { engine, operation, handler } = makeEngine();
    await ensureStarted(engine);
    const firstCaller = { actorId: "same-fields" };
    expect(await engine.protectedOperations.execute(operation, firstCaller, { value: "a" }))
      .toMatchObject({ status: "executed" });
    expect(await engine.protectedOperations.execute(operation, firstCaller, { value: "b" }))
      .toMatchObject({ status: "denied" });
    expect(await engine.protectedOperations.execute(operation, { actorId: "same-fields" }, { value: "c" }))
      .toMatchObject({ status: "executed" });
    expect(handler).toHaveBeenCalledTimes(2);
  });


  it("keeps an already-admitted handler in flight during shutdown without claiming cancellation", async () => {
    let release!: (value: string) => void;
    let signalHandlerStarted!: () => void;
    const handlerStarted = new Promise<void>((resolve) => { signalHandlerStarted = resolve; });
    let handlerSignal: AbortSignal | undefined;
    const engine = new CoreEngine({ policy: { evaluate: async () => allow } });
    const handler = vi.fn((_input: string, context: { operationId: string; signal: AbortSignal }) => {
      handlerSignal = context.signal;
      signalHandlerStarted();
      return new Promise<string>((resolve) => { release = resolve; });
    });
    const operation = engine.registerProtectedOperation({
      id: "records.in-flight",
      action: "record.write",
      resource: "record:in-flight",
      validateInput: (value: unknown): value is string => typeof value === "string",
      handler
    });
    await ensureStarted(engine);
    const pending = engine.protectedOperations.execute(operation, { actorId: "in-flight" }, "work");
    await handlerStarted;
    expect(handler).toHaveBeenCalledTimes(1);
    const stopping = engine.stop();
    await stopping;
    expect(handlerSignal?.aborted).toBe(false);
    release("completed");
    expect(await pending).toEqual({ status: "executed", value: "completed" });
  });

  it("fails closed for non-cloneable context values before PolicyEngine", async () => {
    const evaluator = vi.fn(async () => allow);
    const { engine, operation, handler } = makeEngine(evaluator);
    await ensureStarted(engine);
    const result = await engine.protectedOperations.execute(
      operation,
      { actorId: "non-cloneable", context: { attributes: { invalid: new Date() } } },
      { value: "x" }
    );
    expect(result).toMatchObject({ status: "denied" });
    expect(evaluator).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });


  it("rejects new requests after shutdown begins without invoking PolicyEngine", async () => {
    const evaluator = vi.fn(async () => allow);
    const { engine, operation, handler } = makeEngine(evaluator);
    await ensureStarted(engine);
    await engine.stop();
    const result = await engine.protectedOperations.execute(operation, { actorId: "after-stop" }, { value: "x" });
    expect(result).toMatchObject({ status: "denied" });
    expect(evaluator).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("propagates parent cancellation to policy evaluation and blocks the handler", async () => {
    const controller = new AbortController();
    let evaluatorSignal: AbortSignal | undefined;
    const { engine, operation, handler } = makeEngine((_request, options) => {
      evaluatorSignal = options?.signal;
      return new Promise<PolicyDecision>(() => undefined);
    });
    await ensureStarted(engine);
    const pending = engine.protectedOperations.execute(
      operation, caller, { value: "no" }, { parentSignal: controller.signal }
    );
    await Promise.resolve();
    controller.abort();
    const result = await pending;
    expect(result).toMatchObject({ status: "denied" });
    expect(evaluatorSignal?.aborted).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });


  it("passes the same detached immutable snapshot to validation and the handler", async () => {
    let validatedInput: unknown;
    let handledInput: unknown;
    const original = { value: "before", nested: { label: "stable" } };
    const engine = new CoreEngine({ policy: { evaluate: async () => allow } });
    const operation = engine.registerProtectedOperation({
      id: "records.input-snapshot",
      action: "record.write",
      resource: "record:snapshot",
      validateInput: (value: unknown): value is typeof original => {
        validatedInput = value;
        return typeof value === "object" && value !== null &&
          "value" in value && typeof value.value === "string";
      },
      handler: (value) => {
        handledInput = value;
        return value.value;
      }
    });
    await ensureStarted(engine);
    const result = await engine.protectedOperations.execute(
      operation, { actorId: "snapshot-input" }, original
    );
    original.value = "mutated";
    original.nested.label = "mutated";

    expect(result).toEqual({ status: "executed", value: "before" });
    expect(validatedInput).toBe(handledInput);
    expect(handledInput).not.toBe(original);
    expect(handledInput).toEqual({ value: "before", nested: { label: "stable" } });
    expect(Object.isFrozen(handledInput)).toBe(true);
    expect(Object.isFrozen((handledInput as typeof original).nested)).toBe(true);
  });

  it("fails closed when the validator attempts to mutate the immutable snapshot", async () => {
    const handler = vi.fn(async () => "must-not-run");
    const evaluator = vi.fn(async () => allow);
    const engine = new CoreEngine({ policy: { evaluate: evaluator } });
    const operation = engine.registerProtectedOperation({
      id: "records.mutating-validator",
      action: "record.write",
      resource: "record:mutation",
      validateInput: (value: unknown): value is { value: string } => {
        Object.assign(value as object, { value: "tampered" });
        return true;
      },
      handler
    });
    await ensureStarted(engine);
    const result = await engine.protectedOperations.execute(
      operation, { actorId: "mutating-validator" }, { value: "original" }
    );

    expect(result).toMatchObject({ status: "denied" });
    expect(evaluator).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects an unbounded or cyclic operation input before validation and policy", async () => {
    const validator = vi.fn((value: unknown): value is object => true);
    const evaluator = vi.fn(async () => allow);
    const handler = vi.fn(async () => "must-not-run");
    const engine = new CoreEngine({ policy: { evaluate: evaluator } });
    const operation = engine.registerProtectedOperation({
      id: "records.invalid-snapshot",
      action: "record.write",
      resource: "record:invalid",
      validateInput: validator,
      handler
    });
    await ensureStarted(engine);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const result = await engine.protectedOperations.execute(
      operation, { actorId: "invalid-snapshot" }, cyclic
    );

    expect(result).toMatchObject({ status: "denied" });
    expect(validator).not.toHaveBeenCalled();
    expect(evaluator).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("preserves undefined as a valid protected-operation input", async () => {
    const engine = new CoreEngine({ policy: { evaluate: async () => allow } });
    const handler = vi.fn(async (value: undefined) => value === undefined ? "valid" : "invalid");
    const operation = engine.registerProtectedOperation({
      id: "records.undefined-input",
      action: "record.read",
      resource: "record:undefined",
      validateInput: (value: unknown): value is undefined => value === undefined,
      handler
    });
    await ensureStarted(engine);
    const result = await engine.protectedOperations.execute(
      operation, { actorId: "undefined-input" }, undefined
    );

    expect(result).toEqual({ status: "executed", value: "valid" });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(undefined, expect.objectContaining({
      registrationId: "records.undefined-input",
      operationId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    }));
  });

});
