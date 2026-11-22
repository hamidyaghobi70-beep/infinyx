import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { fork } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { CoreEngine } from "../../src/core/core-engine.js";
import { CoreError } from "../../src/core/core-error.js";
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
  it("terminates active policy processes before cleaning modules", async () => {
    const observer = observeRunning();
    const runtime = new ProcessIsolatedPolicyEngine({
      moduleUrl: fixtureUrl,
      terminationGraceMs: 20,
      killWaitMs: 1_000,
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

  it("marks CoreEngine unresolved and blocks cleanup until an evaluator really settles", async () => {
    let release!: (decision: { effect: "allow"; reason: string }) => void;
    let evaluatorStarted!: () => void;
    const started = new Promise<void>((resolve) => { evaluatorStarted = resolve; });
    let cleanupCalls = 0;
    const policy = {
      evaluate: () => {
        evaluatorStarted();
        return new Promise<{ effect: "allow"; reason: string }>((resolve) => {
          release = resolve;
        });
      }
    };
    const engine = new CoreEngine({ policy, policyShutdownTimeoutMs: 15 });
    engine.register({
      id: "worker",
      version: "1.0.0",
      stop: () => { cleanupCalls += 1; }
    });
    await engine.initialize();

    const evaluation = engine.policy.evaluate(request);
    await started;
    await expect(engine.stop()).rejects.toMatchObject({
      code: "POLICY_SHUTDOWN_TIMEOUT"
    });
    await expect(evaluation).resolves.toMatchObject({ effect: "deny" });
    expect(engine.state).toBe("unresolved");
    expect(cleanupCalls).toBe(0);

    // Retry is safe only after the original delegate promise settles.
    release({ effect: "allow", reason: "late result must not authorize" });
    await engine.stop();
    expect(cleanupCalls).toBe(1);
    expect(engine.state).toBe("stopped");
  });

  it("maps a structured unresolved child-process shutdown to unresolved and permits retry", async () => {
    let shutdownAttempts = 0;
    let cleanupCalls = 0;
    const policy = {
      evaluate: async () => ({ effect: "deny" as const, reason: "test" }),
      shutdown: async () => {
        shutdownAttempts += 1;
        if (shutdownAttempts === 1) {
          throw new CoreError("POLICY_RUNTIME_UNRESOLVED", "child exit not yet confirmed");
        }
      }
    };
    const engine = new CoreEngine({ policy });
    engine.register({
      id: "worker",
      version: "1.0.0",
      stop: () => { cleanupCalls += 1; }
    });
    await engine.initialize();

    await expect(engine.stop()).rejects.toMatchObject({ code: "POLICY_RUNTIME_UNRESOLVED" });
    expect(engine.state).toBe("unresolved");
    expect(cleanupCalls).toBe(0);

    await engine.stop();
    expect(shutdownAttempts).toBe(2);
    expect(cleanupCalls).toBe(1);
    expect(engine.state).toBe("stopped");
  });

  it("keeps CoreEngine unresolved until a real child close event, then retries cleanup exactly once", async () => {
    const killSignals: (NodeJS.Signals | undefined)[] = [];
    const child = Object.assign(new EventEmitter(), {
      connected: true,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      send: (message: unknown): boolean => {
        if (typeof message === "object" && message !== null &&
            (message as { type?: unknown }).type === "evaluate") {
          queueMicrotask(() => child.emit("message", { type: "started" }));
        }
        return true;
      },
      kill: (signal?: NodeJS.Signals): boolean => {
        killSignals.push(signal);
        return true;
      }
    });
    const controlledFork = (() => {
      queueMicrotask(() => child.emit("spawn"));
      return child as unknown as ReturnType<typeof fork>;
    }) as typeof fork;
    const observer = observeRunning();
    const runtime = new ProcessIsolatedPolicyEngine({
      moduleUrl: fixtureUrl,
      terminationGraceMs: 5,
      killWaitMs: 25,
      forkProcess: controlledFork,
      onStateChange: observer.onStateChange
    });
    let cleanupCalls = 0;
    const engine = new CoreEngine({
      policy: runtime,
      policyShutdownTimeoutMs: 1_000
    });
    engine.register({
      id: "worker",
      version: "1.0.0",
      stop: () => { cleanupCalls += 1; }
    });
    await engine.initialize();

    const evaluation = engine.policy.evaluate(request);
    await observer.reached;

    await expect(engine.stop()).rejects.toMatchObject({
      code: "POLICY_RUNTIME_UNRESOLVED"
    });
    await expect(evaluation).resolves.toMatchObject({ effect: "deny" });
    expect(engine.state).toBe("unresolved");
    expect(killSignals).toContain("SIGKILL");
    expect(runtime.activeExecutionCount).toBe(1);
    expect(cleanupCalls).toBe(0);

    // A retry before the actual close event must remain unresolved and must not clean up.
    await expect(engine.stop()).rejects.toMatchObject({
      code: "POLICY_RUNTIME_UNRESOLVED"
    });
    expect(runtime.activeExecutionCount).toBe(1);
    expect(cleanupCalls).toBe(0);

    child.connected = false;
    child.emit("close", 0, null);
    expect(runtime.activeExecutionCount).toBe(0);

    await engine.stop();
    expect(engine.state).toBe("stopped");
    expect(cleanupCalls).toBe(1);
    await engine.stop();
    expect(cleanupCalls).toBe(1);
  });

  it("rejects shutdown timer values outside the supported Node.js timer range", () => {
    expect(() => new CoreEngine({ policyShutdownTimeoutMs: 2_147_483_648 }))
      .toThrow(/positive safe integer/);
    expect(() => new CoreEngine({ protectedOperationDrainTimeoutMs: 1.5 }))
      .toThrow(/positive safe integer/);
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
