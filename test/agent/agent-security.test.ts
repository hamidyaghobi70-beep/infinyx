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

  it("does not change Core default-deny policy or register privileged operations", async () => {
    const core = new CoreEngine();
    const agent = new AgentModule({ modelPort: { complete: async () => "answer" } });
    core.register(agent);
    await core.initialize();
    await core.start();

    await expect(core.policy.evaluate({
      actorId: "untrusted",
      action: "agent.execute",
      resource: "agent:agent"
    })).resolves.toMatchObject({ effect: "deny" });
    expect(core.getModules().map((module) => module.id)).toEqual(["agent"]);
    await core.stop();
  });
});
