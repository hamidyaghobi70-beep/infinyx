import { ProtectedOperationExecutor } from "../../src/core/protected-operation-executor.js";
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

  it("fails closed when caller cancellation options or signals have hostile getters", async () => {
    const { engine, operation, handler } = makeEngine();
    await ensureStarted(engine);

    const hostileOptions = new Proxy({}, {
      get() { throw new Error("hostile options getter"); }
    });
    await expect(engine.protectedOperations.execute(
      operation, caller, { value: "no" }, hostileOptions as never
    )).resolves.toMatchObject({ status: "denied" });

    const hostileSignal = new Proxy({ aborted: false }, {
      get(target, property, receiver) {
        if (property === "addEventListener") throw new Error("hostile signal getter");
        return Reflect.get(target, property, receiver);
      }
    });
    await expect(engine.protectedOperations.execute(
      operation, { actorId: "hostile-signal" }, { value: "no" },
      { signal: hostileSignal as unknown as AbortSignal }
    )).resolves.toMatchObject({ status: "denied" });

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


  it("assigns distinct invocation IDs to repeated executions of one registration", async () => {
    const { engine, operation, handler } = makeEngine();
    await ensureStarted(engine);
    await engine.protectedOperations.execute(operation, { actorId: "first" }, { value: "one" });
    await engine.protectedOperations.execute(operation, { actorId: "second" }, { value: "two" });
    const firstContext = handler.mock.calls[0]?.[1];
    const secondContext = handler.mock.calls[1]?.[1];
    expect(firstContext?.operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(secondContext?.operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(firstContext?.operationId).not.toBe(secondContext?.operationId);
  });

  it("drains an admitted handler before allowing module cleanup", async () => {
    let release!: (value: string) => void;
    let signalHandlerStarted!: () => void;
    const handlerStarted = new Promise<void>((resolve) => { signalHandlerStarted = resolve; });
    let handlerSignal: AbortSignal | undefined;
    let moduleStopped = false;
    const engine = new CoreEngine({ policy: { evaluate: async () => allow } });
    engine.register({
      id: "resource-owner",
      version: "1.0.0",
      stop: () => { moduleStopped = true; }
    });
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
    expect(handlerSignal?.aborted).toBe(true);
    expect(moduleStopped).toBe(false);
    release("completed");
    await stopping;
    expect(moduleStopped).toBe(true);
    expect(await pending).toEqual({ status: "executed", value: "completed" });
  });


  it("waits for every concurrently admitted handler before module cleanup", async () => {
    const releases = new Map<string, (value: string) => void>();
    const started = new Set<string>();
    let signalStarted!: () => void;
    const allStarted = new Promise<void>((resolve) => { signalStarted = resolve; });
    let moduleStops = 0;
    const engine = new CoreEngine({ policy: { evaluate: async () => allow } });
    engine.register({
      id: "concurrent-resource-owner",
      version: "1.0.0",
      stop: () => { moduleStops += 1; }
    });
    const operation = engine.registerProtectedOperation({
      id: "records.concurrent",
      action: "record.write",
      resource: "record:concurrent",
      validateInput: (value: unknown): value is string => typeof value === "string",
      handler: (value) => new Promise<string>((resolve) => {
        releases.set(value, resolve);
        started.add(value);
        if (started.size === 2) signalStarted();
      })
    });
    await ensureStarted(engine);
    const first = engine.protectedOperations.execute(
      operation, { actorId: "concurrent-first" }, "first"
    );
    const second = engine.protectedOperations.execute(
      operation, { actorId: "concurrent-second" }, "second"
    );
    await allStarted;

    const stopping = engine.stop();
    expect(moduleStops).toBe(0);
    releases.get("first")?.("first-done");
    await Promise.resolve();
    expect(moduleStops).toBe(0);

    releases.get("second")?.("second-done");
    await stopping;
    expect(await first).toEqual({ status: "executed", value: "first-done" });
    expect(await second).toEqual({ status: "executed", value: "second-done" });
    expect(moduleStops).toBe(1);
  });

  it("blocks cleanup after a handler drain deadline and observes late settlement without replay", async () => {
    let release!: (value: string) => void;
    let signalHandlerStarted!: () => void;
    const handlerStarted = new Promise<void>((resolve) => { signalHandlerStarted = resolve; });
    let handlerCalls = 0;
    let moduleStops = 0;
    const engine = new CoreEngine({
      policy: { evaluate: async () => allow },
      protectedOperationShutdown: { drainDeadlineMs: 5 }
    });
    engine.register({
      id: "resource-owner",
      version: "1.0.0",
      stop: () => { moduleStops += 1; }
    });
    const operation = engine.registerProtectedOperation({
      id: "records.pending",
      action: "record.write",
      resource: "record:pending",
      validateInput: (value: unknown): value is string => typeof value === "string",
      handler: () => {
        handlerCalls += 1;
        signalHandlerStarted();
        return new Promise<string>((resolve) => { release = resolve; });
      }
    });
    await ensureStarted(engine);
    const pending = engine.protectedOperations.execute(operation, { actorId: "pending" }, "work");
    await handlerStarted;
    await expect(engine.stop()).rejects.toMatchObject({
      code: "PROTECTED_OPERATION_DRAIN_TIMEOUT"
    });
    expect(moduleStops).toBe(0);
    release("late-completion");
    await pending;
    await engine.stop();
    expect(handlerCalls).toBe(1);
    expect(moduleStops).toBe(1);
  });

  it("keeps an unresolved delegate evaluation tracked after wrapper cancellation", async () => {
    let release!: (decision: typeof allow) => void;
    let moduleStops = 0;
    const engine = new CoreEngine({
      policy: {
        evaluate: () => new Promise((resolve) => { release = resolve; })
      },
      policyTimeoutMs: 5_000,
      protectedOperationShutdown: { drainDeadlineMs: 5 }
    });
    engine.register({
      id: "policy-resource",
      version: "1.0.0",
      stop: () => { moduleStops += 1; }
    });
    const operation = engine.registerProtectedOperation({
      id: "records.policy-pending",
      action: "record.read",
      resource: "record:policy-pending",
      validateInput: (value: unknown): value is string => typeof value === "string",
      handler: (value) => value
    });
    await ensureStarted(engine);
    const pending = engine.protectedOperations.execute(
      operation, { actorId: "policy-pending" }, "value"
    );
    await Promise.resolve();
    await expect(engine.stop()).rejects.toMatchObject({
      code: "POLICY_EVALUATION_DRAIN_TIMEOUT"
    });
    expect(moduleStops).toBe(0);
    release(allow);
    expect(await pending).toMatchObject({ status: "denied" });
    await engine.stop();
    expect(moduleStops).toBe(1);
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


  it("drains detached and nested child activities before module cleanup", async () => {
    let releaseNested!: () => void;
    let signalNestedStarted!: () => void;
    const nestedStarted = new Promise<void>((resolve) => { signalNestedStarted = resolve; });
    let moduleStops = 0;
    const engine = new CoreEngine({ policy: { evaluate: async () => allow } });
    engine.register({
      id: "child-resource-owner",
      version: "1.0.0",
      stop: () => { moduleStops += 1; }
    });
    const operation = engine.registerProtectedOperation({
      id: "records.child-activity",
      action: "record.write",
      resource: "record:child-activity",
      validateInput: (value: unknown): value is string => typeof value === "string",
      handler: (_value, context) => {
        // Deliberately detached: the operation scope, not the handler's await
        // chain, owns this work and its nested descendant.
        void context.runChild(async (childContext) => {
          await childContext.runChild(() => new Promise<void>((resolve) => {
            releaseNested = resolve;
            signalNestedStarted();
          }));
        });
        return "handler-returned";
      }
    });
    await ensureStarted(engine);
    const pending = engine.protectedOperations.execute(
      operation, { actorId: "child-activity" }, "work"
    );
    await nestedStarted;

    const stopping = engine.stop();
    expect(moduleStops).toBe(0);
    releaseNested();
    await stopping;

    expect(await pending).toEqual({ status: "executed", value: "handler-returned" });
    expect(moduleStops).toBe(1);
  });

  it("reports detached child failure only after the child settles", async () => {
    let rejectChild!: (error: Error) => void;
    let signalChildStarted!: () => void;
    const childStarted = new Promise<void>((resolve) => { signalChildStarted = resolve; });
    let moduleStops = 0;
    const engine = new CoreEngine({ policy: { evaluate: async () => allow } });
    engine.register({
      id: "child-failure-resource",
      version: "1.0.0",
      stop: () => { moduleStops += 1; }
    });
    const operation = engine.registerProtectedOperation({
      id: "records.child-failure",
      action: "record.write",
      resource: "record:child-failure",
      validateInput: (value: unknown): value is string => typeof value === "string",
      handler: (_value, context) => {
        void context.runChild(() => new Promise<void>((_resolve, reject) => {
          rejectChild = reject;
          signalChildStarted();
        }));
        return "handler-returned";
      }
    });
    await ensureStarted(engine);
    const pending = engine.protectedOperations.execute(
      operation, { actorId: "child-failure" }, "work"
    );
    await childStarted;

    const stopping = engine.stop();
    expect(moduleStops).toBe(0);
    rejectChild(new Error("private child failure detail"));
    await stopping;

    expect(await pending).toEqual({
      status: "failed",
      reason: "Protected operation handler or child activity failed."
    });
    expect(moduleStops).toBe(1);
  });


  it("closes child registration scopes when their owning task settles", async () => {
    let capturedContext: import("../../src/core/contracts.js").ProtectedOperationChildContext | undefined;
    let lateChildStarted = false;
    const { engine, operation } = makeEngine(async () => allow);
    const scopedOperation = engine.registerProtectedOperation({
      id: "records.closed-child-scope",
      action: "record.write",
      resource: "record:closed-child-scope",
      validateInput: (value: unknown): value is string => typeof value === "string",
      handler: (_value, context) => {
        capturedContext = context;
        return "finished";
      }
    });
    await ensureStarted(engine);
    const result = await engine.protectedOperations.execute(
      scopedOperation, { actorId: "closed-child-scope" }, "work"
    );
    expect(result).toEqual({ status: "executed", value: "finished" });
    await expect(capturedContext?.runChild(() => {
      lateChildStarted = true;
    })).rejects.toThrow("Child activity scope is already closed.");
    expect(lateChildStarted).toBe(false);
    await engine.stop();
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

  it("rejects a cyclic operation input before validation and policy", async () => {
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
  });
});


describe("protected executor policy decision trust boundary", () => {
  it("does not invoke policy decision getters after authorization", async () => {
    let getterCalls = 0;
    const hostileDecision = Object.defineProperties({}, {
      effect: {
        enumerable: true,
        get() {
          getterCalls += 1;
          throw new Error("decision getter must not execute");
        }
      },
      reason: { enumerable: true, value: "malicious decision" }
    });
    const handler = vi.fn(async () => "must-not-run");
    const executor = new ProtectedOperationExecutor({
      evaluate: async () => hostileDecision as never
    }, () => true);
    const operation = executor.register({
      id: "security.hostile-policy-decision",
      action: "record.read",
      resource: "record:hostile",
      validateInput: (value: unknown): value is { value: string } =>
        typeof value === "object" && value !== null &&
        "value" in value && typeof value.value === "string",
      handler
    });

    const result = await executor.execute(
      operation,
      { actorId: "hostile-policy-test" },
      { value: "safe input" }
    );

    expect(result).toMatchObject({ status: "denied" });
    expect(getterCalls).toBe(0);
    expect(handler).not.toHaveBeenCalled();
  });
});


describe("protected executor caller snapshot trust boundary", () => {
  it("rejects accessor-backed caller identity without invoking its getter", async () => {
    let getterCalls = 0;
    const caller = Object.defineProperty({}, "actorId", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("caller getter must not execute");
      }
    });
    const policy = vi.fn(async () => allow);
    const handler = vi.fn(async () => "must-not-run");
    const executor = new ProtectedOperationExecutor({
      evaluate: policy
    }, () => true);
    const operation = executor.register({
      id: "security.hostile-caller",
      action: "record.read",
      resource: "record:caller",
      validateInput: (value: unknown): value is { value: string } =>
        typeof value === "object" && value !== null &&
        "value" in value && typeof value.value === "string",
      handler
    });

    const result = await executor.execute(operation, caller as never, { value: "input" });

    expect(result).toMatchObject({ status: "denied" });
    expect(getterCalls).toBe(0);
    expect(policy).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });
});


describe("protected-operation cancellation cleanup hardening", () => {
  it("denies a non-finite deadline before policy evaluation", async () => {
    const evaluator = vi.fn(async () => allow);
    const { engine, operation, handler } = makeEngine(evaluator);
    await ensureStarted(engine);

    const result = await engine.protectedOperations.execute(
      operation,
      { actorId: "invalid-deadline" },
      { value: "no" },
      { deadlineAt: Number.POSITIVE_INFINITY }
    );

    expect(result).toMatchObject({ status: "denied" });
    expect(evaluator).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    await engine.stop();
  });

  it("cleans up the parent listener even when caller listener cleanup throws", async () => {
    let parentCleanupCalls = 0;
    const callerSignal = {
      aborted: false,
      addEventListener: () => undefined,
      removeEventListener: () => { throw new Error("caller cleanup failed"); }
    } as unknown as AbortSignal;
    const parentSignal = {
      aborted: false,
      addEventListener: () => undefined,
      removeEventListener: () => { parentCleanupCalls += 1; }
    } as unknown as AbortSignal;
    const { engine, operation } = makeEngine();
    await ensureStarted(engine);

    const result = await engine.protectedOperations.execute(
      operation,
      { actorId: "independent-cleanup" },
      { value: "ok" },
      { signal: callerSignal, parentSignal }
    );

    expect(result).toEqual({ status: "executed", value: "OK" });
    expect(parentCleanupCalls).toBe(1);
    await engine.stop();
  });
});


describe("protected-operation child activity resource bounds", () => {
  it("rejects child activity beyond the per-operation concurrency limit", async () => {
    let releaseChildren!: () => void;
    const childGate = new Promise<void>((resolve) => { releaseChildren = resolve; });
    let childrenRegistered!: () => void;
    const registered = new Promise<void>((resolve) => { childrenRegistered = resolve; });
    const engine = new CoreEngine({ policy: { evaluate: async () => allow } });
    const operation = engine.registerProtectedOperation({
      id: "records.child-limit",
      action: "record.write",
      resource: "record:bounded",
      validateInput: isRecordInput,
      handler: async (_input, context) => {
        const children = Array.from({ length: 1024 }, () =>
          context.runChild(async () => childGate)
        );
        await expect(context.runChild(async () => undefined))
          .rejects.toThrow(/concurrency limit/i);
        childrenRegistered();
        await Promise.all(children);
        return "bounded";
      }
    });
    await ensureStarted(engine);

    const pending = engine.protectedOperations.execute(
      operation, { actorId: "child-limit" }, { value: "ok" }
    );
    await registered;
    releaseChildren();
    await expect(pending).resolves.toEqual({ status: "executed", value: "bounded" });
    await engine.stop();
  });

  it("rejects child activity beyond the maximum nesting depth", async () => {
    const engine = new CoreEngine({ policy: { evaluate: async () => allow } });
    const operation = engine.registerProtectedOperation({
      id: "records.child-depth",
      action: "record.write",
      resource: "record:depth",
      validateInput: isRecordInput,
      handler: async (_input, context) => {
        const descend = async (scope: typeof context, depth: number): Promise<void> => {
          await scope.runChild(async (childScope) => {
            if (depth === 63) {
              await expect(childScope.runChild(async () => undefined))
                .rejects.toThrow(/nesting limit/i);
              return;
            }
            await descend(childScope, depth + 1);
          });
        };
        await descend(context, 0);
        return "bounded";
      }
    });
    await ensureStarted(engine);

    await expect(engine.protectedOperations.execute(
      operation, { actorId: "child-depth" }, { value: "ok" }
    )).resolves.toEqual({ status: "executed", value: "bounded" });
    await engine.stop();
  });
});


describe("global protected-operation admission bound", () => {
  it("caps admitted handlers across the entire Core Engine", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let allStarted!: () => void;
    const started = new Promise<void>((resolve) => { allStarted = resolve; });
    let startedCount = 0;
    const handler = async () => {
      startedCount += 1;
      if (startedCount === 256) allStarted();
      await gate;
      return "complete";
    };
    const engine = new CoreEngine({ policy: { evaluate: async () => allow } });
    const operation = engine.registerProtectedOperation({
      id: "records.global-limit",
      action: "record.write",
      resource: "record:global",
      validateInput: (value: unknown): value is undefined => value === undefined,
      handler
    });
    await ensureStarted(engine);

    const active = Array.from({ length: 256 }, (_, index) =>
      engine.protectedOperations.execute(
        operation, { actorId: "global-limit-" + index }, undefined
      )
    );
    await started;

    const overflow = await engine.protectedOperations.execute(
      operation, { actorId: "global-limit-overflow" }, undefined
    );
    expect(overflow).toMatchObject({ status: "denied" });
    expect(startedCount).toBe(256);

    release();
    const results = await Promise.all(active);
    expect(results).toHaveLength(256);
    expect(results.every((result) => result.status === "executed")).toBe(true);
    await engine.stop();
  });
});


describe("child registration after cancellation", () => {
  it("rejects new descendants after the parent operation is cancelled", async () => {
    const callerController = new AbortController();
    let releaseChild!: () => void;
    const childGate = new Promise<void>((resolve) => { releaseChild = resolve; });
    let childStarted!: () => void;
    const started = new Promise<void>((resolve) => { childStarted = resolve; });
    const nestedHandler = vi.fn(async () => "must-not-run");
    let nestedRejected = false;

    const engine = new CoreEngine({ policy: { evaluate: async () => allow } });
    const operation = engine.registerProtectedOperation({
      id: "records.cancelled-child-registration",
      action: "record.write",
      resource: "record:cancelled",
      validateInput: isRecordInput,
      handler: async (_input, context) => {
        const child = context.runChild(async (childContext) => {
          childStarted();
          await childGate;
          await expect(childContext.runChild(nestedHandler))
            .rejects.toThrow(/closed after cancellation/i);
        });
        await child;
        return "completed";
      }
    });
    await ensureStarted(engine);

    const pending = engine.protectedOperations.execute(
      operation,
      { actorId: "cancelled-child-registration" },
      { value: "ok" },
      { signal: callerController.signal }
    );
    await started;
    callerController.abort();
    releaseChild();

    await expect(pending).resolves.toEqual({ status: "executed", value: "completed" });
    expect(nestedHandler).not.toHaveBeenCalled();
    await engine.stop();
  });
});
