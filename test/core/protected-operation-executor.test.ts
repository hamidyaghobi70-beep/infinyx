import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreEngine } from "../../src/core/core-engine.js";
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
  it("executes a handler only after a valid Allow decision", async () => {
    const { engine, operation, handler } = makeEngine();
    await ensureStarted(engine);
    const result = await engine.protectedOperations.execute(operation, caller, { value: "ok" });
    expect(result).toEqual({ status: "executed", value: "OK" });
    expect(handler).toHaveBeenCalledTimes(1);
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


  it("cancels and drains an admitted handler before module cleanup", async () => {
    let release!: (value: string) => void;
    let signalHandlerStarted!: () => void;
    const handlerStarted = new Promise<void>((resolve) => { signalHandlerStarted = resolve; });
    let handlerSignal: AbortSignal | undefined;
    let cleanupCalls = 0;
    const engine = new CoreEngine({ policy: { evaluate: async () => allow } });
    const handler = vi.fn((_input: string, context: { operationId: string; operationDefinitionId: string; signal: AbortSignal }) => {
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
    engine.register({ id: "resource-owner", version: "1.0.0", stop: () => { cleanupCalls += 1; } });
    await ensureStarted(engine);
    const pending = engine.protectedOperations.execute(operation, { actorId: "in-flight" }, "work");
    await handlerStarted;
    expect(handler).toHaveBeenCalledTimes(1);
    const stopping = engine.stop();
    expect(handlerSignal?.aborted).toBe(true);
    expect(cleanupCalls).toBe(0);
    release("completed");
    expect(await pending).toEqual({ status: "executed", value: "completed" });
    await stopping;
    expect(cleanupCalls).toBe(1);
  });

  it("assigns a distinct invocation ID to each execution of one definition", async () => {
    const observed: Array<{ operationId: string; operationDefinitionId: string }> = [];
    const engine = new CoreEngine({ policy: { evaluate: async () => allow } });
    const operation = engine.registerProtectedOperation({
      id: "records.correlated",
      action: "record.read",
      resource: "record:correlated",
      validateInput: (value: unknown): value is string => typeof value === "string",
      handler: (_input, context) => {
        observed.push({
          operationId: context.operationId,
          operationDefinitionId: context.operationDefinitionId
        });
        return "ok";
      }
    });
    await ensureStarted(engine);
    await engine.protectedOperations.execute(operation, { actorId: "first" }, "x");
    await engine.protectedOperations.execute(operation, { actorId: "second" }, "x");
    expect(observed).toHaveLength(2);
    expect(observed[0].operationId).not.toBe(observed[1].operationId);
    expect(observed[0].operationDefinitionId).toBe("records.correlated");
    expect(observed[1].operationDefinitionId).toBe("records.correlated");
  });

  it("keeps unresolved handlers tracked after a drain timeout and observes them on a later stop", async () => {
    vi.useFakeTimers();
    let release!: (value: string) => void;
    let signalHandlerStarted!: () => void;
    const handlerStarted = new Promise<void>((resolve) => { signalHandlerStarted = resolve; });
    let handlerSignal: AbortSignal | undefined;
    let cleanupCalls = 0;
    const engine = new CoreEngine({
      policy: { evaluate: async () => allow },
      protectedOperationShutdown: { drainDeadlineMs: 10 }
    });
    const operation = engine.registerProtectedOperation({
      id: "records.timeout-drain",
      action: "record.write",
      resource: "record:timeout-drain",
      validateInput: (value: unknown): value is string => typeof value === "string",
      handler: (_input, context) => {
        handlerSignal = context.signal;
        signalHandlerStarted();
        return new Promise<string>((resolve) => { release = resolve; });
      }
    });
    engine.register({ id: "resource-owner", version: "1.0.0", stop: () => { cleanupCalls += 1; } });
    await ensureStarted(engine);
    const pending = engine.protectedOperations.execute(operation, { actorId: "timeout" }, "work");
    await handlerStarted;
    const firstStop = engine.stop();
    await vi.advanceTimersByTimeAsync(10);
    await expect(firstStop).rejects.toMatchObject({ code: "PROTECTED_OPERATION_DRAIN_TIMEOUT" });
    expect(engine.state).toBe("stopping");
    expect(handlerSignal?.aborted).toBe(true);
    expect(cleanupCalls).toBe(0);
    release("late-completion");
    expect(await pending).toEqual({ status: "executed", value: "late-completion" });
    await engine.stop();
    expect(cleanupCalls).toBe(1);
    expect(engine.state).toBe("stopped");
  });

  it("drains an admitted handler even when no modules were initialized", async () => {
    let release!: (value: string) => void;
    let signalHandlerStarted!: () => void;
    const handlerStarted = new Promise<void>((resolve) => { signalHandlerStarted = resolve; });
    const engine = new CoreEngine({ policy: { evaluate: async () => allow } });
    const operation = engine.registerProtectedOperation({
      id: "records.no-modules",
      action: "record.write",
      resource: "record:no-modules",
      validateInput: (value: unknown): value is string => typeof value === "string",
      handler: () => {
        signalHandlerStarted();
        return new Promise<string>((resolve) => { release = resolve; });
      }
    });
    await ensureStarted(engine);
    const pending = engine.protectedOperations.execute(operation, { actorId: "no-modules" }, "work");
    await handlerStarted;
    const stopping = engine.stop();
    expect(engine.state).toBe("stopping");
    release("done");
    expect(await pending).toEqual({ status: "executed", value: "done" });
    await stopping;
    expect(engine.state).toBe("stopped");
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


});
