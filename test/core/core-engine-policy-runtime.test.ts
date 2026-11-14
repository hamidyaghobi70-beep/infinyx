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

    await expect(engine.stop()).rejects.toMatchObject({ code: "POLICY_SHUTDOWN_FAILED" });
    expect(cleanupCalls).toBe(0);
    expect(engine.state).toBe("stopping");

    await engine.stop();
    expect(shutdownAttempts).toBe(2);
    expect(cleanupCalls).toBe(1);
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
