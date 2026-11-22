import { describe, expect, it } from "vitest";
import { CoreEngine } from "../../src/core/core-engine.js";
import { AgentModule } from "../../src/agent/agent-module.js";

const allowAgent = {
  evaluate: async () => ({ effect: "allow" as const, reason: "Test policy allowed Agent execution." })
};
const trustedCaller = () => ({ actorId: "trusted:test-principal" });

describe("Agent CoreModule lifecycle", () => {
  it("executes only through a Core-registered protected operation", async () => {
    const core = new CoreEngine({ policy: allowAgent });
    const agent = new AgentModule({
      modelPort: { complete: async () => "ok" },
      callerProvider: trustedCaller
    });
    agent.registerWithCore(core);

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

  it("fails closed when the trusted caller provider is absent", async () => {
    const core = new CoreEngine({ policy: allowAgent });
    const agent = new AgentModule({ modelPort: { complete: async () => "must-not-run" } });
    agent.registerWithCore(core);
    await core.initialize();
    await core.start();

    await expect(agent.execute({ taskId: "no-principal", prompt: "hello" }))
      .resolves.toMatchObject({
        status: "rejected",
        reason: expect.stringContaining("Trusted Agent caller is unavailable")
      });
    await core.stop();
  });

  it("supports a host provider that reuses one immutable principal object", async () => {
    const principal = Object.freeze({ actorId: "trusted:shared-principal" });
    const core = new CoreEngine({ policy: allowAgent });
    const agent = new AgentModule({
      modelPort: { complete: async () => "ok" },
      callerProvider: () => principal
    });
    agent.registerWithCore(core);
    await core.initialize();
    await core.start();

    await expect(agent.execute({ taskId: "first", prompt: "hello" }))
      .resolves.toMatchObject({ status: "completed" });
    await expect(agent.execute({ taskId: "second", prompt: "hello again" }))
      .resolves.toMatchObject({ status: "completed" });
    await core.stop();
  });

  it("stops accepting new work as shutdown begins", async () => {
    const core = new CoreEngine({ policy: allowAgent });
    const agent = new AgentModule({
      modelPort: { complete: async () => "ok" },
      callerProvider: trustedCaller
    });
    agent.registerWithCore(core);
    await core.initialize();
    await core.start();
    const stopping = core.stop();
    expect(agent.isAccepting).toBe(false);
    await stopping;
    expect(agent.isAccepting).toBe(false);
    await expect(agent.execute({ taskId: "after-shutdown", prompt: "hello" }))
      .resolves.toMatchObject({ status: "rejected" });
  });

  it("keeps Core shutdown pending until a non-cooperative Provider really settles", async () => {
    let release!: (value: string) => void;
    let providerStarted!: () => void;
    const started = new Promise<void>((resolve) => { providerStarted = resolve; });
    const gate = new Promise<string>((resolve) => { release = resolve; });
    const core = new CoreEngine({
      policy: allowAgent,
      protectedOperationDrainTimeoutMs: 2_000
    });
    const agent = new AgentModule({
      modelPort: {
        complete: () => {
          providerStarted();
          return gate;
        }
      },
      callerProvider: trustedCaller
    });
    agent.registerWithCore(core);
    await core.initialize();
    await core.start();

    const pending = agent.execute({ taskId: "in-flight", prompt: "hello" });
    await started;

    let stopSettled = false;
    const stopping = core.stop().then(() => { stopSettled = true; });
    await Promise.resolve();

    expect(agent.getTaskStatus("in-flight")).toMatchObject({
      status: "cancelled",
      executionState: "unresolved"
    });
    expect(stopSettled).toBe(false);

    release("late provider response");
    await expect(pending).resolves.toMatchObject({
      status: "cancelled",
      executionState: "settled"
    });
    await stopping;
    expect(stopSettled).toBe(true);
    expect(core.state).toBe("stopped");
    expect(agent.getTaskStatus("in-flight")).toMatchObject({
      status: "cancelled",
      executionState: "settled"
    });
  });

  it("marks Core unresolved and blocks cleanup when Provider never settles", async () => {
    let providerStarted!: () => void;
    const started = new Promise<void>((resolve) => { providerStarted = resolve; });
    const core = new CoreEngine({
      policy: allowAgent,
      protectedOperationDrainTimeoutMs: 20
    });
    let cleanupCalls = 0;
    const agent = new AgentModule({
      modelPort: {
        complete: () => {
          providerStarted();
          return new Promise<string>(() => undefined);
        }
      },
      callerProvider: trustedCaller
    });
    agent.registerWithCore(core);
    core.register({
      id: "cleanup-probe",
      version: "1.0.0",
      stop: () => { cleanupCalls += 1; }
    });
    await core.initialize();
    await core.start();

    const pending = agent.execute({ taskId: "never-settles", prompt: "hello" });
    await started;
    await expect(core.stop()).rejects.toMatchObject({
      code: "PROTECTED_OPERATION_DRAIN_TIMEOUT"
    });
    expect(core.state).toBe("unresolved");
    expect(cleanupCalls).toBe(0);
    expect(agent.getTaskStatus("never-settles")).toMatchObject({
      status: "cancelled",
      executionState: "unresolved"
    });
    void pending;
  });
});
