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

  it("does not invoke ModelPort when shutdown wins before the provider microtask", async () => {
    let calls = 0;
    const runtime = new AgentRuntime({
      complete: async () => {
        calls += 1;
        return "unexpected";
      }
    });
    runtime.start();
    const pending = runtime.execute({ taskId: "shutdown-before-provider", prompt: "hello" });

    // Intentionally do not yield: shutdown occurs before the queued provider microtask.
    runtime.shutdown();

    await expect(pending).resolves.toMatchObject({
      status: "cancelled",
      executionState: "settled"
    });
    expect(calls).toBe(0);
    expect(runtime.getTaskStatus("shutdown-before-provider")).toMatchObject({
      status: "cancelled",
      executionState: "settled"
    });
  });

  it("does not release capacity for a cancelled non-cooperative provider", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const controller = new AbortController();
    const runtime = new AgentRuntime({
      complete: () => {
        markStarted();
        return new Promise<string>(() => {
          // Deliberately ignore AbortSignal and never settle.
        });
      }
    });
    runtime.start();

    const first = runtime.execute({
      taskId: "non-cooperative-cancelled",
      prompt: "hold",
      signal: controller.signal
    });
    await started;
    controller.abort();
    await expect(first).resolves.toMatchObject({
      status: "cancelled",
      executionState: "unresolved"
    });

    const rest = Array.from({ length: 31 }, (_, index) =>
      runtime.execute({ taskId: `non-cooperative-fill-${index}`, prompt: "hold" })
    );
    await expect(runtime.execute({ taskId: "non-cooperative-overflow", prompt: "extra" }))
      .resolves.toMatchObject({
        status: "rejected",
        code: "CAPACITY_EXCEEDED"
      });

    runtime.shutdown();
    await Promise.all(rest);
  });

  it("releases capacity after timed-out providers eventually settle", async () => {
    let release!: (value: string) => void;
    const gate = new Promise<string>((resolve) => { release = resolve; });
    let calls = 0;
    const runtime = new AgentRuntime({
      complete: () => (++calls <= 32 ? gate : Promise.resolve("capacity restored"))
    });
    runtime.start();
    const pending = Array.from({ length: 32 }, (_, index) =>
      runtime.execute({ taskId: `timeout-capacity-${index}`, prompt: "hold", timeoutMs: 5 })
    );
    const timedOut = await Promise.all(pending);
    expect(timedOut.every((result) => result.status === "timed_out")).toBe(true);

    await expect(runtime.execute({ taskId: "timeout-capacity-overflow", prompt: "extra" }))
      .resolves.toMatchObject({ status: "rejected", code: "CAPACITY_EXCEEDED" });

    release("late settlement");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(runtime.execute({ taskId: "timeout-capacity-restored", prompt: "next" }))
      .resolves.toMatchObject({ status: "completed", output: "capacity restored" });
    await runtime.shutdown();
  });

  it("releases capacity after cancellation before provider invocation", async () => {
    let providerCalls = 0;
    const runtime = new AgentRuntime({
      complete: async () => {
        providerCalls += 1;
        return "capacity restored";
      }
    });
    runtime.start();
    const pending = Array.from({ length: 32 }, (_, index) =>
      runtime.execute({ taskId: `prestart-cancel-${index}`, prompt: "cancel before microtask" })
    );

    // Do not yield between admission and shutdown: no ModelPort call may start.
    runtime.shutdown();
    const results = await Promise.all(pending);
    expect(results.every((result) =>
      result.status === "cancelled" && result.executionState === "settled"
    )).toBe(true);
    expect(providerCalls).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 0));
    runtime.start();
    await expect(runtime.execute({ taskId: "prestart-capacity-restored", prompt: "next" }))
      .resolves.toMatchObject({ status: "completed", output: "capacity restored" });
    await runtime.shutdown();
  });

  it("keeps unresolved tasks in the active capacity until their providers settle", async () => {
    let release!: (value: string) => void;
    const gate = new Promise<string>((resolve) => { release = resolve; });
    const runtime = new AgentRuntime({ complete: () => gate });
    runtime.start();
    const pending = Array.from({ length: 32 }, (_, index) =>
      runtime.execute({ taskId: `unresolved-capacity-${index}`, prompt: "hold", timeoutMs: 5 })
    );
    const results = await Promise.all(pending);
    expect(results.every((result) =>
      result.status === "timed_out" && result.executionState === "unresolved"
    )).toBe(true);

    await expect(runtime.execute({ taskId: "unresolved-capacity-overflow", prompt: "extra" }))
      .resolves.toMatchObject({ status: "rejected", code: "CAPACITY_EXCEEDED" });

    release("providers settled");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(runtime.execute({ taskId: "unresolved-capacity-restored", prompt: "next" }))
      .resolves.toMatchObject({ status: "completed" });
    await runtime.shutdown();
  });
});
