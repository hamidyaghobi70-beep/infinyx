import { describe, expect, it } from "vitest";
import { CoreEngine } from "../../src/core/core-engine.js";
import { AgentModule } from "../../src/agent/agent-module.js";

describe("Agent CoreModule lifecycle", () => {
  it("starts and stops through CoreEngine ModuleContext", async () => {
    const core = new CoreEngine();
    const agent = new AgentModule({ modelPort: { complete: async () => "ok" } });
    core.register(agent);

    await expect(agent.execute({ taskId: "before", prompt: "hello" }))
      .resolves.toMatchObject({ status: "rejected" });
    await core.initialize();
    expect(core.getModuleStates().get("agent")).toBe("initialized");
    await core.start();
    expect(core.getModuleStates().get("agent")).toBe("running");
    await expect(agent.execute({ taskId: "running", prompt: "hello" }))
      .resolves.toMatchObject({ status: "completed", output: "ok" });
    await core.stop();
    expect(core.getModuleStates().get("agent")).toBe("stopped");
    await expect(agent.execute({ taskId: "after", prompt: "hello" }))
      .resolves.toMatchObject({ status: "rejected" });
  });

  it("stops accepting new work as shutdown begins", async () => {
    const core = new CoreEngine();
    const agent = new AgentModule({ modelPort: { complete: async () => "ok" } });
    core.register(agent);
    await core.initialize();
    await core.start();
    const stopping = core.stop();
    // CoreEngine aborts ModuleContext.shutdownSignal synchronously at stop initiation.
    expect(agent.isAccepting).toBe(false);
    await stopping;
    expect(agent.isAccepting).toBe(false);
    await expect(agent.execute({ taskId: "after-shutdown", prompt: "hello" }))
      .resolves.toMatchObject({ status: "rejected" });
  });

  it("requests cooperative cancellation of in-flight work when Core shutdown begins", async () => {
    let release!: (value: string) => void;
    const gate = new Promise<string>((resolve) => { release = resolve; });
    const core = new CoreEngine();
    const agent = new AgentModule({ modelPort: { complete: () => gate } });
    core.register(agent);
    await core.initialize();
    await core.start();

    const pending = agent.execute({ taskId: "in-flight", prompt: "hello" });
    await Promise.resolve();
    const stopping = core.stop();
    await expect(pending).resolves.toMatchObject({ status: "cancelled", executionState: "unresolved" });
    await stopping;
    expect(agent.getTaskStatus("in-flight")).toMatchObject({
      status: "cancelled", executionState: "unresolved"
    });

    release("late provider response");
    await Promise.resolve();
    await Promise.resolve();
    expect(agent.getTaskStatus("in-flight")).toMatchObject({
      status: "cancelled", executionState: "settled"
    });
  });
});
