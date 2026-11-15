import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../../src/agent/agent-runtime.js";
import { MAX_ACTIVE_TASKS } from "../../src/agent/agent-contracts.js";
import { DisabledModelPort, type ModelPort } from "../../src/agent/model-port.js";

describe("AgentRuntime", () => {
  it("uses a disabled provider by default and never contacts a live service", async () => {
    const runtime = new AgentRuntime(new DisabledModelPort());
    runtime.start();
    await expect(runtime.execute({ taskId: "disabled-1", prompt: "hello" }))
      .resolves.toMatchObject({ status: "error", code: "MODEL_PROVIDER_ERROR" });
    await runtime.shutdown();
  });

  it("completes a bounded request through ModelPort", async () => {
    const calls: unknown[] = [];
    const model: ModelPort = {
      complete: async (request) => {
        calls.push(request);
        return "A concise plan.";
      }
    };
    const runtime = new AgentRuntime(model);
    runtime.start();

    await expect(runtime.execute({ taskId: "task-1", prompt: "Plan a local study session." }))
      .resolves.toEqual({ status: "completed", taskId: "task-1", output: "A concise plan." });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ deadlineAt: expect.any(Number), prompt: expect.stringContaining("User task:") });
    await runtime.shutdown();
  });

  it("rejects invalid task identifiers, blank prompts and excessive prompts", async () => {
    const runtime = new AgentRuntime({ complete: async () => "unused" }, { maxPromptLength: 10 });
    runtime.start();
    await expect(runtime.execute({ taskId: "../bad", prompt: "ok" })).resolves.toMatchObject({ status: "rejected" });
    await expect(runtime.execute({ taskId: "blank", prompt: "  " })).resolves.toMatchObject({ status: "rejected" });
    await expect(runtime.execute({ taskId: "long", prompt: "x".repeat(11) })).resolves.toMatchObject({ status: "rejected" });
    await runtime.shutdown();
  });

  it("rejects duplicate active task identifiers", async () => {
    let release!: (value: string) => void;
    const gate = new Promise<string>((resolve) => { release = resolve; });
    const runtime = new AgentRuntime({ complete: () => gate });
    runtime.start();
    const first = runtime.execute({ taskId: "same", prompt: "first" });
    await Promise.resolve();
    await expect(runtime.execute({ taskId: "same", prompt: "second" }))
      .resolves.toMatchObject({ status: "rejected", reason: expect.stringContaining("already active") });
    release("done");
    await expect(first).resolves.toMatchObject({ status: "completed" });
    await runtime.shutdown();
  });

  it("reports provider errors without leaking exception details", async () => {
    const runtime = new AgentRuntime({ complete: async () => { throw new Error("secret endpoint"); } });
    runtime.start();
    await expect(runtime.execute({ taskId: "provider-error", prompt: "hello" }))
      .resolves.toEqual({ status: "error", taskId: "provider-error", code: "MODEL_PROVIDER_ERROR" });
    expect(runtime.getTaskStatus("provider-error")?.reason).toBe("Model provider failed.");
    expect(runtime.getTaskStatus("provider-error")?.reason).not.toContain("secret endpoint");
    await runtime.shutdown();
  });

  it("rejects oversized model output", async () => {
    const runtime = new AgentRuntime({ complete: async () => "x".repeat(20) }, { maxOutputLength: 10 });
    runtime.start();
    await expect(runtime.execute({ taskId: "large-output", prompt: "hello" }))
      .resolves.toMatchObject({ status: "error", code: "INVALID_MODEL_RESPONSE" });
    await runtime.shutdown();
  });

  it("rejects tasks when the active task capacity is exhausted", async () => {
    let release!: (value: string) => void;
    const gate = new Promise<string>((resolve) => { release = resolve; });
    const runtime = new AgentRuntime({ complete: () => gate });
    runtime.start();

    const active = Array.from({ length: MAX_ACTIVE_TASKS }, (_, index) =>
      runtime.execute({ taskId: `capacity-${index}`, prompt: "hold" })
    );
    await Promise.resolve();

    await expect(runtime.execute({ taskId: "capacity-overflow", prompt: "extra" }))
      .resolves.toMatchObject({
        status: "rejected",
        reason: expect.stringContaining("active task limit"),
        code: "CAPACITY_EXCEEDED"
      });

    release("released");
    await expect(Promise.all(active)).resolves.toHaveLength(MAX_ACTIVE_TASKS);
    await runtime.shutdown();
  });

  it("reserves all capacity synchronously before provider promises settle", async () => {
    let providerCalls = 0;
    const runtime = new AgentRuntime({
      complete: () => {
        providerCalls += 1;
        return new Promise<string>(() => {
          // Intentionally never settle: this test observes admission, then shuts down.
        });
      }
    });
    runtime.start();

    // No await between execute calls: all reservations must happen synchronously.
    const pending = Array.from({ length: MAX_ACTIVE_TASKS }, (_, index) =>
      runtime.execute({ taskId: `sync-reserve-${index}`, prompt: "hold" })
    );
    const overflow = runtime.execute({ taskId: "sync-reserve-overflow", prompt: "extra" });

    await expect(overflow).resolves.toMatchObject({
      status: "rejected",
      code: "CAPACITY_EXCEEDED"
    });
    expect(providerCalls).toBe(MAX_ACTIVE_TASKS);

    runtime.shutdown();
    await expect(Promise.all(pending)).resolves.toHaveLength(MAX_ACTIVE_TASKS);
  });

  it("releases all capacity slots after successful provider settlement", async () => {
    let release!: (value: string) => void;
    const gate = new Promise<string>((resolve) => { release = resolve; });
    let calls = 0;
    const runtime = new AgentRuntime({
      complete: () => (++calls <= MAX_ACTIVE_TASKS ? gate : Promise.resolve("capacity restored"))
    });
    runtime.start();
    const active = Array.from({ length: MAX_ACTIVE_TASKS }, (_, index) =>
      runtime.execute({ taskId: `success-release-${index}`, prompt: "hold" })
    );
    await Promise.resolve();
    release("done");
    await Promise.all(active);
    await expect(runtime.execute({ taskId: "success-after-release", prompt: "next" }))
      .resolves.toMatchObject({ status: "completed", output: "capacity restored" });
    await runtime.shutdown();
  });

  it("releases all capacity slots after provider errors settle", async () => {
    let fail!: (reason: Error) => void;
    const gate = new Promise<string>((_resolve, reject) => { fail = reject; });
    let calls = 0;
    const runtime = new AgentRuntime({
      complete: () => (++calls <= MAX_ACTIVE_TASKS ? gate : Promise.resolve("capacity restored"))
    });
    runtime.start();
    const active = Array.from({ length: MAX_ACTIVE_TASKS }, (_, index) =>
      runtime.execute({ taskId: `error-release-${index}`, prompt: "hold" })
    );
    await Promise.resolve();
    fail(new Error("provider failure"));
    await Promise.all(active);
    await expect(runtime.execute({ taskId: "error-after-release", prompt: "next" }))
      .resolves.toMatchObject({ status: "completed", output: "capacity restored" });
    await runtime.shutdown();
  });
});
