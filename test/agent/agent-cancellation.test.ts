import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../../src/agent/agent-runtime.js";

describe("Agent cancellation and deadlines", () => {
  it("propagates caller AbortSignal to ModelPort", async () => {
    let received: AbortSignal | undefined;
    const runtime = new AgentRuntime({
      complete: async ({ signal }) => {
        received = signal;
        return await new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
    });
    runtime.start();
    const controller = new AbortController();
    const pending = runtime.execute({ taskId: "cancel", prompt: "hello", signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await expect(pending).resolves.toMatchObject({ status: "cancelled", executionState: "unresolved" });
    expect(received?.aborted).toBe(true);
    await runtime.shutdown();
  });

  it("keeps a non-cooperative provider visibly unresolved after timeout", async () => {
    let release!: (value: string) => void;
    const gate = new Promise<string>((resolve) => { release = resolve; });
    const runtime = new AgentRuntime({ complete: () => gate });
    runtime.start();
    const result = await runtime.execute({ taskId: "timeout", prompt: "hello", timeoutMs: 5 });
    expect(result).toMatchObject({ status: "timed_out", executionState: "unresolved" });
    expect(runtime.getTaskStatus("timeout")).toMatchObject({
      status: "timed_out", executionState: "unresolved"
    });
    const duplicate = await runtime.execute({ taskId: "timeout", prompt: "retry" });
    expect(duplicate).toMatchObject({ status: "rejected" });
    release("late response");
    await Promise.resolve();
    await Promise.resolve();
    expect(runtime.getTaskStatus("timeout")).toMatchObject({ status: "timed_out", executionState: "settled" });
    await runtime.shutdown();
  });

  it("does not claim provider termination when shutdown cancellation is ignored", async () => {
    let release!: (value: string) => void;
    const gate = new Promise<string>((resolve) => { release = resolve; });
    const runtime = new AgentRuntime({ complete: () => gate });
    runtime.start();
    const pending = runtime.execute({ taskId: "shutdown", prompt: "hello" });
    await Promise.resolve();
    runtime.shutdown();
    await expect(pending).resolves.toMatchObject({ status: "cancelled", executionState: "unresolved" });
    expect(runtime.getTaskStatus("shutdown")).toMatchObject({
      status: "cancelled", executionState: "unresolved"
    });
    release("late");
    await Promise.resolve();
    await Promise.resolve();
    expect(runtime.getTaskStatus("shutdown")).toMatchObject({
      status: "cancelled", executionState: "settled"
    });
  });
});
