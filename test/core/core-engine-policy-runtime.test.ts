import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { CoreEngine } from "../../src/core/core-engine.js";
import { ProcessIsolatedPolicyEngine } from "../../src/core/process-isolated-policy-engine.js";
import type { PolicyRequest } from "../../src/core/contracts.js";

const fixtureUrl = pathToFileURL(fileURLToPath(
  new URL("../fixtures/policy-evaluator-fixture.mjs", import.meta.url)
)).href;

const request: PolicyRequest = {
  actorId: "core",
  action: "hang",
  resource: "policy:test"
};

function observeRunning(): { reached: Promise<void>; onStateChange: (event: { state: string }) => void } {
  let resolve!: () => void;
  const reached = new Promise<void>((done) => { resolve = done; });
  return {
    reached,
    onStateChange: (event) => {
      if (event.state === "RUNNING") resolve();
    }
  };
}

describe("CoreEngine policy runtime shutdown", () => {
  it("requires ProcessIsolatedPolicyEngine when process isolation is configured", () => {
    expect(() => new CoreEngine({
      requireProcessIsolation: true,
      policy: {
        evaluate: async () => ({ effect: "allow" as const, reason: "in-process" })
      }
    })).toThrow(/requires a ProcessIsolatedPolicyEngine/i);

    expect(() => new CoreEngine({
      requireProcessIsolation: true,
      policy: new ProcessIsolatedPolicyEngine({ moduleUrl: fixtureUrl })
    })).not.toThrow();
  });

  it("denies a non-finite deadline before spawning a policy process", async () => {
    const runtime = new ProcessIsolatedPolicyEngine({ moduleUrl: fixtureUrl });
    await expect(runtime.evaluate(request, { deadlineAt: Number.NaN })).resolves.toEqual({
      effect: "deny",
      reason: "Policy deadline is invalid; access denied."
    });
    expect(runtime.activeExecutionCount).toBe(0);
  });

  it("terminates active policy processes before cleaning modules", async () => {
    const observer = observeRunning();
    const runtime = new ProcessIsolatedPolicyEngine({
      moduleUrl: fixtureUrl,
      onStateChange: observer.onStateChange
    });
    const order: string[] = [];
    const engine = new CoreEngine({ policy: runtime });
    engine.register({
      id: "worker",
      version: "1.0.0",
      stop: () => { order.push("module-cleanup"); }
    });
    await engine.initialize();

    const evaluation = engine.policy.evaluate(request);
    await observer.reached;
    await engine.stop();
    const decision = await evaluation;

    expect(decision.effect).toBe("deny");
    expect(runtime.activeExecutionCount).toBe(0);
    expect(order).toEqual(["module-cleanup"]);
    expect(engine.state).toBe("stopped");
    await expect(engine.policy.evaluate({ ...request, action: "allow" }))
      .resolves.toMatchObject({ effect: "deny" });
  });

  it("does not clean modules while policy runtime shutdown is unresolved", async () => {
    let shutdownAttempts = 0;
    let cleanupCalls = 0;
    const policy = {
      evaluate: async () => ({ effect: "allow" as const, reason: "test allow" }),
      shutdown: async () => {
        shutdownAttempts += 1;
        if (shutdownAttempts === 1) throw new Error("runtime unresolved");
      }
    };
    const engine = new CoreEngine({ policy });
    engine.register({
      id: "worker",
      version: "1.0.0",
      stop: () => { cleanupCalls += 1; }
    });
    await engine.initialize();

    await expect(engine.stop()).rejects.toThrow(/module cleanup was not started/i);
    expect(cleanupCalls).toBe(0);
    expect(engine.state).toBe("failed");

    await engine.stop();
    expect(shutdownAttempts).toBe(2);
    expect(cleanupCalls).toBe(1);
    expect(engine.state).toBe("stopped");
  });

  it("bounds a policy shutdown that never settles and blocks module cleanup", async () => {
    let cleanupCalls = 0;
    const engine = new CoreEngine({
      policyShutdownTimeoutMs: 15,
      policy: {
        evaluate: async () => ({ effect: "deny" as const, reason: "test" }),
        shutdown: () => new Promise<void>(() => undefined)
      }
    });
    engine.register({
      id: "worker",
      version: "1.0.0",
      stop: () => { cleanupCalls += 1; }
    });
    await engine.initialize();

    await expect(engine.stop()).rejects.toMatchObject({
      code: "POLICY_SHUTDOWN_TIMEOUT"
    });
    expect(engine.state).toBe("unresolved");
    expect(cleanupCalls).toBe(0);
  });

  it("keeps shutdown unresolved and never runs a handler after a late Allow", async () => {
    let release!: (decision: { effect: "allow"; reason: string }) => void;
    let evaluatorStarted!: () => void;
    const started = new Promise<void>((resolve) => { evaluatorStarted = resolve; });
    let handlerCalls = 0;
    let cleanupCalls = 0;
    const engine = new CoreEngine({
      policyShutdownTimeoutMs: 20,
      policy: {
        evaluate: () => new Promise((resolve) => {
          evaluatorStarted();
          release = resolve;
        }),
        shutdown: async () => undefined
      }
    });
    const operation = engine.registerProtectedOperation({
      id: "late-allow",
      action: "record.write",
      resource: "record:late-allow",
      validateInput: (value: unknown): value is string => typeof value === "string",
      handler: () => { handlerCalls += 1; return "executed"; }
    });
    engine.register({
      id: "worker",
      version: "1.0.0",
      stop: () => { cleanupCalls += 1; }
    });
    await engine.initialize();
    await engine.start();

    const pending = engine.protectedOperations.execute(
      operation,
      { actorId: "late-allow-test" },
      "input"
    );
    await started;

    await expect(engine.stop()).rejects.toMatchObject({
      code: "POLICY_SHUTDOWN_TIMEOUT"
    });
    expect(engine.state).toBe("unresolved");
    expect(cleanupCalls).toBe(0);
    expect(handlerCalls).toBe(0);

    release({ effect: "allow", reason: "late allow after stop" });
    await expect(pending).resolves.toMatchObject({ status: "denied" });
    await engine.stop();

    expect(handlerCalls).toBe(0);
    expect(cleanupCalls).toBe(1);
    expect(engine.state).toBe("stopped");
  });

  it("notifies modules immediately but defers cleanup until handlers drain", async () => {
    let handlerStarted!: () => void;
    const started = new Promise<void>((resolve) => { handlerStarted = resolve; });
    let releaseHandler!: () => void;
    let moduleShutdownSignal: AbortSignal | undefined;
    let cancellationRequested = false;
    let handlerSettled = false;
    let cleanupCalls = 0;
    let cleanupSawSettledHandler = false;
    const engine = new CoreEngine({
      policy: {
        evaluate: async () => ({ effect: "allow" as const, reason: "test allow" })
      }
    });
    const operation = engine.registerProtectedOperation({
      id: "shutdown-order",
      action: "record.read",
      resource: "record:shutdown-order",
      validateInput: (value: unknown): value is string => typeof value === "string",
      handler: (_input, context) => new Promise<string>((resolve) => {
        handlerStarted();
        releaseHandler = () => {
          handlerSettled = true;
          resolve("drained");
        };
        context.signal.addEventListener("abort", () => {
          cancellationRequested = true;
        }, { once: true });
      })
    });
    engine.register({
      id: "worker",
      version: "1.0.0",
      initialize: (context) => { moduleShutdownSignal = context.shutdownSignal; },
      stop: () => {
        cleanupCalls += 1;
        cleanupSawSettledHandler = handlerSettled;
      }
    });
    await engine.initialize();
    await engine.start();

    const pending = engine.protectedOperations.execute(
      operation,
      { actorId: "shutdown-order-test" },
      "input"
    );
    await started;
    const stopping = engine.stop();

    expect(moduleShutdownSignal?.aborted).toBe(true);
    expect(cancellationRequested).toBe(true);
    expect(cleanupCalls).toBe(0);

    releaseHandler();
    await expect(pending).resolves.toMatchObject({ status: "executed", value: "drained" });
    await stopping;

    expect(cleanupCalls).toBe(1);
    expect(cleanupSawSettledHandler).toBe(true);
    expect(engine.state).toBe("stopped");
  });

  it("shuts down a policy runtime even when CoreEngine was never initialized", async () => {
    let shutdownCalls = 0;
    const engine = new CoreEngine({
      policy: {
        evaluate: async () => ({ effect: "allow", reason: "test" }),
        shutdown: async () => { shutdownCalls += 1; }
      }
    });
    await engine.stop();
    expect(shutdownCalls).toBe(1);
    expect(engine.state).toBe("stopped");
  });
});
