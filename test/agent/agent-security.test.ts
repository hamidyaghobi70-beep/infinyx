import { describe, expect, it } from "vitest";
import { CoreEngine } from "../../src/core/core-engine.js";
import { AgentModule } from "../../src/agent/agent-module.js";
import { AgentRuntime } from "../../src/agent/agent-runtime.js";

describe("Agent security boundary", () => {
  it("rejects caller-supplied identity and unsupported request fields", async () => {
    const runtime = new AgentRuntime({ complete: async () => "ok" });
    runtime.start();
    await expect(runtime.execute({
      taskId: "identity", prompt: "hello", actorId: "admin"
    })).resolves.toMatchObject({ status: "rejected", reason: expect.stringContaining("unsupported") });
    await runtime.shutdown();
  });

  it("rejects accessor properties rather than invoking them", async () => {
    const runtime = new AgentRuntime({ complete: async () => "ok" });
    runtime.start();
    let invoked = false;
    const request = Object.defineProperty(
      { taskId: "accessor", prompt: "hello" },
      "timeoutMs",
      { enumerable: true, get: () => { invoked = true; return 100; } }
    );
    await expect(runtime.execute(request)).resolves.toMatchObject({ status: "rejected" });
    expect(invoked).toBe(false);
    await runtime.shutdown();
  });

  it("rejects non-plain request objects", async () => {
    const runtime = new AgentRuntime({ complete: async () => "ok" });
    runtime.start();
    await expect(runtime.execute(new (class Task { taskId = "class"; prompt = "hello"; })()))
      .resolves.toMatchObject({ status: "rejected" });
    await runtime.shutdown();
  });

  it("does not bypass Core policy through AgentModule.execute", async () => {
    const core = new CoreEngine();
    const agent = new AgentModule({
      modelPort: { complete: async () => "must-not-run" },
      callerProvider: () => ({ actorId: "untrusted:caller" })
    });
    agent.registerWithCore(core);
    await core.initialize();
    await core.start();

    await expect(agent.execute({ taskId: "policy-denied", prompt: "hello" }))
      .resolves.toMatchObject({ status: "rejected" });
    await expect(core.policy.evaluate({
      actorId: "untrusted:caller",
      action: "agent.execute",
      resource: "agent:agent"
    })).resolves.toMatchObject({ effect: "deny" });
    expect(core.getModules().map((module) => module.id)).toEqual(["agent"]);
    await core.stop();
  });

  it("fails closed when the host does not provide a trusted principal", async () => {
    let policyCalls = 0;
    const core = new CoreEngine({
      policy: {
        evaluate: async () => {
          policyCalls += 1;
          return { effect: "allow", reason: "must not be reached" };
        }
      }
    });
    const agent = new AgentModule({ modelPort: { complete: async () => "must-not-run" } });
    agent.registerWithCore(core);
    await core.initialize();
    await core.start();

    await expect(agent.execute({ taskId: "missing-principal", prompt: "hello" }))
      .resolves.toMatchObject({ status: "rejected" });
    expect(policyCalls).toBe(0);
    await core.stop();
  });
});
