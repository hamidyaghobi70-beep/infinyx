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

  it("returns false when atomic publication has no subscribers", async () => {
    const bus = new InMemoryEventBus();

    await expect(bus.publishIfSubscribed("sample.created", {})).resolves.toBe(false);
  });

  it("dispatches to the captured subscriber snapshot when unsubscription races with delivery", async () => {
    const bus = new InMemoryEventBus();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const handler = vi.fn(async () => { await gate; });
    const unsubscribe = bus.subscribe("sample.created", handler);

    const publishing = bus.publishIfSubscribed("sample.created", { id: "one" });
    unsubscribe();
    release();

    await expect(publishing).resolves.toBe(true);
    expect(handler).toHaveBeenCalledOnce();
    expect(await bus.publishIfSubscribed("sample.created", {})).toBe(false);
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


describe("InMemoryEventBus trust and resource boundaries", () => {
  it("rejects invalid event names and non-function handlers", () => {
    const bus = new InMemoryEventBus();
    expect(() => bus.subscribe(" ".repeat(1), vi.fn())).toThrow(/event type/i);
    expect(() => bus.subscribe("x".repeat(129), vi.fn())).toThrow(/event type/i);
    expect(() => bus.subscribe("valid.event", null as never)).toThrow(/handler/i);
    expect(() => bus.hasSubscribers(7 as never)).toThrow(/event type/i);
  });

  it("delivers a detached deeply immutable payload snapshot", async () => {
    const bus = new InMemoryEventBus();
    const original = { nested: { value: "before" } };
    let observed: unknown;
    bus.subscribe("snapshot.event", (event) => {
      observed = event.payload;
      expect(Object.isFrozen(event.payload)).toBe(true);
      expect(Object.isFrozen((event.payload as typeof original).nested)).toBe(true);
    });
    await bus.publish("snapshot.event", original);
    original.nested.value = "after";
    expect(observed).toEqual({ nested: { value: "before" } });
  });

  it("rejects accessor-backed or cyclic payloads without invoking getters", async () => {
    const bus = new InMemoryEventBus();
    const handler = vi.fn();
    bus.subscribe("unsafe.event", handler);
    let getterCalls = 0;
    const hostile = Object.defineProperty({}, "secret", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("payload getter must not run");
      }
    });
    await expect(bus.publish("unsafe.event", hostile)).rejects.toThrow(/payload/i);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(bus.publish("unsafe.event", cyclic)).rejects.toThrow(/payload/i);
    expect(getterCalls).toBe(0);
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not share a mutable occurredAt Date instance between handlers", async () => {
    const bus = new InMemoryEventBus();
    let secondTimestamp = 0;
    bus.subscribe("timestamp.event", (event) => {
      event.occurredAt.setTime(0);
    });
    bus.subscribe("timestamp.event", (event) => {
      secondTimestamp = event.occurredAt.getTime();
    });
    await bus.publish("timestamp.event", {});
    expect(secondTimestamp).toBeGreaterThan(0);
  });

  it("enforces per-event and global subscriber limits without duplicate inflation", () => {
    const bus = new InMemoryEventBus();
    const shared = vi.fn();
    const unsubscribe = bus.subscribe("bounded.event", shared);
    const duplicateUnsubscribe = bus.subscribe("bounded.event", shared);
    duplicateUnsubscribe();
    expect(bus.hasSubscribers("bounded.event")).toBe(true);
    for (let index = 1; index < 256; index += 1) {
      bus.subscribe("bounded.event", () => undefined);
    }
    expect(() => bus.subscribe("bounded.event", () => undefined)).toThrow(/capacity/i);
    unsubscribe();
    expect(bus.hasSubscribers("bounded.event")).toBe(true);
  });

  it("bounds concurrent event dispatches and releases capacity after settlement", async () => {
    const bus = new InMemoryEventBus();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    bus.subscribe("load.event", async () => gate);
    const active = Array.from({ length: 256 }, () => bus.publish("load.event", {}));
    await Promise.resolve();
    await expect(bus.publish("load.event", {})).rejects.toThrow(/capacity/i);
    release();
    await Promise.all(active);
    await expect(bus.publish("load.event", {})).resolves.toBeUndefined();
  });
});
