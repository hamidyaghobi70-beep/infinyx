import { describe, expect, it, vi } from "vitest";
import { InMemoryEventBus } from "../../src/core/event-bus.js";

describe("InMemoryEventBus", () => {
  it("awaits subscribed handlers when publishing", async () => {
    const bus = new InMemoryEventBus();
    const received: number[] = [];
    bus.subscribe<number>("sample.created", async (event) => {
      await Promise.resolve();
      received.push(event.payload);
    });

    await bus.publish("sample.created", 7);

    expect(received).toEqual([7]);
  });

  it("supports unsubscription", async () => {
    const bus = new InMemoryEventBus();
    const handler = vi.fn();
    const unsubscribe = bus.subscribe("sample.created", handler);
    unsubscribe();

    await bus.publish("sample.created", { id: "one" });

    expect(handler).not.toHaveBeenCalled();
  });

  it("reports handler failures after all handlers settle", async () => {
    const bus = new InMemoryEventBus();
    const completed = vi.fn();
    bus.subscribe("sample.created", async () => {
      throw new Error("handler failed");
    });
    bus.subscribe("sample.created", completed);

    await expect(bus.publish("sample.created", {})).rejects.toBeInstanceOf(AggregateError);
    expect(completed).toHaveBeenCalledOnce();
  });
  it("isolates synchronous handler throws and waits for remaining async handlers", async () => {
    const bus = new InMemoryEventBus();
    const completed: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });

    bus.subscribe("sample.created", () => {
      completed.push("throws");
      throw new Error("synchronous handler failure");
    });
    bus.subscribe("sample.created", async () => {
      await gate;
      completed.push("async");
    });
    bus.subscribe("sample.created", () => {
      completed.push("sync sibling");
    });

    const publishing = bus.publish("sample.created", {});
    await Promise.resolve();
    await Promise.resolve();

    expect(completed).toEqual(["throws", "sync sibling"]);
    release();

    await expect(publishing).rejects.toBeInstanceOf(AggregateError);
    expect(completed).toEqual(["throws", "sync sibling", "async"]);
  });

});
