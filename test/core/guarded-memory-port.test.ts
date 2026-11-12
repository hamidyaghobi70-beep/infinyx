import { describe, expect, it, vi } from "vitest";
import type {
  EventBusPort,
  MemoryPort,
  PolicyEngine,
  PolicyRequest
} from "../../src/core/contracts.js";
import { CoreEngine } from "../../src/core/core-engine.js";
import { DefaultDenyPolicyEngine } from "../../src/core/default-policy-engine.js";
import { InMemoryEventBus } from "../../src/core/event-bus.js";
import {
  GuardedMemoryPort,
  MEMORY_ACCESS_DECIDED_EVENT,
  MEMORY_ACCESS_FAILED_EVENT
} from "../../src/core/guarded-memory-port.js";
import type {
  MemoryAccessDecidedEvent,
  MemoryAccessFailedEvent,
  MemoryScope
} from "../../src/core/guarded-memory-port.js";
import { InMemoryMemoryStore } from "../../src/core/in-memory-memory-store.js";
import { MemoryAccessError } from "../../src/core/memory-error.js";

const allowAll: PolicyEngine = {
  evaluate: async () => ({ effect: "allow", reason: "test allow" })
};

const scopeA: MemoryScope = { tenantId: "tenant-a", actorId: "actor-1", moduleId: "module-x" };
const scopeB: MemoryScope = { tenantId: "tenant-b", actorId: "actor-2", moduleId: "module-x" };

function setup(
  overrides: {
    store?: MemoryPort;
    policy?: PolicyEngine;
    events?: EventBusPort;
    scope?: MemoryScope;
    maxValueBytes?: number;
  } = {}
) {
  const memoryStore = new InMemoryMemoryStore();
  const bus = new InMemoryEventBus();
  const decided: MemoryAccessDecidedEvent[] = [];
  const failed: MemoryAccessFailedEvent[] = [];
  bus.subscribe<MemoryAccessDecidedEvent>(MEMORY_ACCESS_DECIDED_EVENT, (event) => {
    decided.push(event.payload);
  });
  bus.subscribe<MemoryAccessFailedEvent>(MEMORY_ACCESS_FAILED_EVENT, (event) => {
    failed.push(event.payload);
  });

  const guard = new GuardedMemoryPort({
    store: overrides.store ?? memoryStore,
    policy: overrides.policy ?? allowAll,
    events: overrides.events ?? bus,
    scope: overrides.scope ?? scopeA,
    ...(overrides.maxValueBytes === undefined ? {} : { maxValueBytes: overrides.maxValueBytes })
  });

  return { guard, memoryStore, bus, decided, failed };
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof MemoryAccessError ? error.code : `UNEXPECTED:${String(error)}`;
  }
}

describe("GuardedMemoryPort — data handling", () => {
  it("round-trips values and never aliases caller or stored objects", async () => {
    const { guard } = setup();
    const address = { namespace: "notes", key: "n1" };
    const original = { count: 1, nested: { items: [1, 2] } };

    await guard.write(address, original);
    original.nested.items.push(3);

    const first = (await guard.read(address)) as typeof original;
    expect(first).toEqual({ count: 1, nested: { items: [1, 2] } });

    first.nested.items.push(99);
    expect(await guard.read(address)).toEqual({ count: 1, nested: { items: [1, 2] } });
  });

  it("returns null for missing entries and treats deleting a missing entry as a no-op", async () => {
    const { guard } = setup();
    const address = { namespace: "notes", key: "missing" };

    expect(await guard.read(address)).toBeNull();
    await expect(guard.delete(address)).resolves.toBeUndefined();
  });

  it("deletes stored entries", async () => {
    const { guard, memoryStore } = setup();
    const address = { namespace: "notes", key: "n1" };

    await guard.write(address, "value");
    expect(memoryStore.size).toBe(1);
    await guard.delete(address);

    expect(await guard.read(address)).toBeNull();
    expect(memoryStore.size).toBe(0);
  });

  it("stores only serialized strings in the backing store", async () => {
    const backing = new InMemoryMemoryStore();
    const { guard } = setup({ store: backing });

    await guard.write({ namespace: "notes", key: "n1" }, { a: 1 });

    const raw = await backing.read(backing.addresses()[0]!);
    expect(raw).toBe('{"a":1}');
  });
});

describe("GuardedMemoryPort — tenant isolation", () => {
  it("keeps identical namespace/key pairs separate across tenants sharing one store", async () => {
    const shared = new InMemoryMemoryStore();
    const a = setup({ store: shared, scope: scopeA }).guard;
    const b = setup({ store: shared, scope: scopeB }).guard;
    const address = { namespace: "profile", key: "settings" };

    await a.write(address, { owner: "a" });
    await b.write(address, { owner: "b" });

    expect(await a.read(address)).toEqual({ owner: "a" });
    expect(await b.read(address)).toEqual({ owner: "b" });

    await a.delete(address);
    expect(await a.read(address)).toBeNull();
    expect(await b.read(address)).toEqual({ owner: "b" });
  });

  it("cannot be made to collide through slash-containing tenant or namespace values", async () => {
    const shared = new InMemoryMemoryStore();
    const first = setup({
      store: shared,
      scope: { tenantId: "a/b", actorId: "actor", moduleId: "m" }
    }).guard;
    const second = setup({
      store: shared,
      scope: { tenantId: "a", actorId: "actor", moduleId: "m" }
    }).guard;

    await first.write({ namespace: "c", key: "k" }, "first");
    await second.write({ namespace: "b/c", key: "k" }, "second");

    expect(shared.size).toBe(2);
    expect(await first.read({ namespace: "c", key: "k" })).toBe("first");
    expect(await second.read({ namespace: "b/c", key: "k" })).toBe("second");
  });

  it("never lets the module influence the tenant prefix of backing addresses", async () => {
    const shared = new InMemoryMemoryStore();
    const { guard } = setup({ store: shared });

    await guard.write({ namespace: "tenant-b/profile", key: "settings" }, "x");

    const [raw] = shared.addresses();
    expect(raw?.namespace.startsWith("tenant-a/")).toBe(true);
    expect(raw?.namespace).toBe("tenant-a/tenant-b%2Fprofile");
  });
});

describe("GuardedMemoryPort — authorization", () => {
  it("denies every operation by default and never touches the backing store", async () => {
    const backing = new InMemoryMemoryStore();
    const readSpy = vi.spyOn(backing, "read");
    const writeSpy = vi.spyOn(backing, "write");
    const deleteSpy = vi.spyOn(backing, "delete");
    const { guard, decided } = setup({ store: backing, policy: new DefaultDenyPolicyEngine() });
    const address = { namespace: "notes", key: "n1" };

    expect(await codeOf(guard.read(address))).toBe("MEMORY_ACCESS_DENIED");
    expect(await codeOf(guard.write(address, "v"))).toBe("MEMORY_ACCESS_DENIED");
    expect(await codeOf(guard.delete(address))).toBe("MEMORY_ACCESS_DENIED");

    expect(readSpy).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(decided.map((event) => [event.operation, event.decision])).toEqual([
      ["read", "deny"],
      ["write", "deny"],
      ["delete", "deny"]
    ]);
  });

  it("does not leak the policy reason through the thrown error", async () => {
    const policy: PolicyEngine = {
      evaluate: async () => ({ effect: "deny", reason: "internal rule 42 failed" })
    };
    const { guard, decided } = setup({ policy });

    const error = await guard.read({ namespace: "n", key: "k" }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MemoryAccessError);
    expect((error as Error).message).not.toContain("rule 42");
    expect(decided[0]?.reason).toBe("internal rule 42 failed");
  });

  it.each([
    ["throws", async () => { throw new Error("policy crashed"); }],
    ["returns null", async () => null],
    ["returns a string", async () => "allow"],
    ["returns an array", async () => []],
    ["uses a wrong-cased effect", async () => ({ effect: "ALLOW", reason: "x" })],
    ["omits the reason", async () => ({ effect: "allow" })],
    ["has a blank reason", async () => ({ effect: "allow", reason: "   " })]
  ])("denies when the policy %s", async (_label, evaluate) => {
    const backing = new InMemoryMemoryStore();
    const policy = { evaluate } as unknown as PolicyEngine;
    const { guard, decided } = setup({ store: backing, policy });

    expect(await codeOf(guard.write({ namespace: "n", key: "k" }, "v"))).toBe("MEMORY_ACCESS_DENIED");

    expect(backing.size).toBe(0);
    expect(decided).toHaveLength(1);
    expect(decided[0]?.decision).toBe("deny");
  });

  it("sends the policy a precise action, resource and context", async () => {
    const requests: PolicyRequest[] = [];
    const policy: PolicyEngine = {
      evaluate: async (request) => {
        requests.push(request);
        return { effect: "allow", reason: "ok" };
      }
    };
    const { guard } = setup({ policy });

    await guard.write({ namespace: "my notes", key: "a/b" }, 1);
    await guard.read({ namespace: "my notes", key: "a/b" });

    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual({
      actorId: "actor-1",
      action: "memory.write",
      resource: "memory://tenant-a/my%20notes/a%2Fb",
      context: { attributes: { tenantId: "tenant-a", moduleId: "module-x", namespace: "my notes" } }
    });
    expect(requests[1]?.action).toBe("memory.read");
  });

  it("allows only what the policy explicitly allows", async () => {
    const policy: PolicyEngine = {
      evaluate: async (request) =>
        request.action === "memory.read"
          ? { effect: "allow", reason: "reads permitted" }
          : { effect: "deny", reason: "writes not permitted" }
    };
    const { guard } = setup({ policy });
    const address = { namespace: "n", key: "k" };

    expect(await guard.read(address)).toBeNull();
    expect(await codeOf(guard.write(address, "v"))).toBe("MEMORY_ACCESS_DENIED");
    expect(await codeOf(guard.delete(address))).toBe("MEMORY_ACCESS_DENIED");
  });
});

describe("GuardedMemoryPort — audit", () => {
  it("publishes an audit event before executing an allowed operation, without the value", async () => {
    const backing = new InMemoryMemoryStore();
    const order: string[] = [];
    const writeOriginal = backing.write.bind(backing);
    vi.spyOn(backing, "write").mockImplementation(async (address, value) => {
      order.push("store.write");
      await writeOriginal(address, value);
    });
    const { guard, bus, decided } = setup({ store: backing });
    bus.subscribe(MEMORY_ACCESS_DECIDED_EVENT, () => {
      order.push("audit");
    });

    await guard.write({ namespace: "notes", key: "n1" }, { secret: "s3cr3t-value" });

    expect(order).toEqual(["audit", "store.write"]);
    expect(decided[0]).toMatchObject({
      tenantId: "tenant-a",
      actorId: "actor-1",
      moduleId: "module-x",
      operation: "write",
      namespace: "notes",
      key: "n1",
      decision: "allow"
    });
    expect(JSON.stringify(decided)).not.toContain("s3cr3t-value");
  });

  it("refuses allowed operations when no audit subscriber is registered", async () => {
    const backing = new InMemoryMemoryStore();
    const bus = new InMemoryEventBus();
    const { guard } = setup({ store: backing, events: bus });

    expect(await codeOf(guard.write({ namespace: "n", key: "k" }, "v"))).toBe("MEMORY_AUDIT_UNAVAILABLE");
    expect(backing.size).toBe(0);
  });

  it("refuses allowed operations when the audit sink is unavailable (fail closed)", async () => {
    const backing = new InMemoryMemoryStore();
    const readSpy = vi.spyOn(backing, "read");
    const events: EventBusPort = {
      subscribe: () => () => undefined,
      hasSubscribers: () => true,
      publish: async () => {
        throw new Error("bus down");
      }
    };
    const { guard } = setup({ store: backing, events });
    const address = { namespace: "n", key: "k" };

    expect(await codeOf(guard.write(address, "v"))).toBe("MEMORY_AUDIT_UNAVAILABLE");
    expect(await codeOf(guard.read(address))).toBe("MEMORY_AUDIT_UNAVAILABLE");
    expect(await codeOf(guard.delete(address))).toBe("MEMORY_AUDIT_UNAVAILABLE");

    expect(backing.size).toBe(0);
    expect(readSpy).not.toHaveBeenCalled();
  });

  it("still reports a denial as a denial when the audit sink is unavailable", async () => {
    const events: EventBusPort = {
      subscribe: () => () => undefined,
      publish: async () => {
        throw new Error("bus down");
      }
    };
    const { guard } = setup({ policy: new DefaultDenyPolicyEngine(), events });

    expect(await codeOf(guard.read({ namespace: "n", key: "k" }))).toBe("MEMORY_ACCESS_DENIED");
  });
});

describe("GuardedMemoryPort — input validation", () => {
  it.each([
    ["empty namespace", { namespace: "", key: "k" }],
    ["whitespace namespace", { namespace: "   ", key: "k" }],
    ["empty key", { namespace: "n", key: "" }],
    ["control character in key", { namespace: "n", key: "a\u0000b" }],
    ["newline in namespace", { namespace: "a\nb", key: "k" }],
    ["DEL in key", { namespace: "n", key: "a\u007fb" }],
    ["over-long namespace", { namespace: "n".repeat(129), key: "k" }],
    ["over-long key", { namespace: "n", key: "k".repeat(257) }],
    ["lone surrogate", { namespace: "n", key: "\ud800" }],
    ["numeric key", { namespace: "n", key: 5 }],
    ["null address", null],
    ["missing address", undefined]
  ])("rejects an invalid address (%s) before policy or backend are involved", async (_label, address) => {
    const evaluate = vi.fn(async () => ({ effect: "allow" as const, reason: "ok" }));
    const backing = new InMemoryMemoryStore();
    const { guard, decided } = setup({ store: backing, policy: { evaluate } });
    const bad = address as never;

    expect(await codeOf(guard.read(bad))).toBe("MEMORY_INVALID_ADDRESS");
    expect(await codeOf(guard.write(bad, "v"))).toBe("MEMORY_INVALID_ADDRESS");
    expect(await codeOf(guard.delete(bad))).toBe("MEMORY_INVALID_ADDRESS");

    expect(evaluate).not.toHaveBeenCalled();
    expect(decided).toHaveLength(0);
    expect(backing.size).toBe(0);
  });

  it("accepts addresses at the exact length limits", async () => {
    const { guard } = setup();
    const address = { namespace: "n".repeat(128), key: "k".repeat(256) };

    await guard.write(address, 1);

    expect(await guard.read(address)).toBe(1);
  });

  it("does not rewrite accepted addresses", async () => {
    const { guard, memoryStore } = setup();

    await guard.write({ namespace: " padded ", key: " key " }, 1);

    expect(memoryStore.addresses()[0]).toEqual({ namespace: "tenant-a/%20padded%20", key: " key " });
  });

  it.each([
    ["undefined", undefined],
    ["a function", () => 1],
    ["a symbol", Symbol("s")],
    ["a bigint", 10n]
  ])("rejects a value that is %s before policy evaluation", async (_label, value) => {
    const evaluate = vi.fn(async () => ({ effect: "allow" as const, reason: "ok" }));
    const { guard } = setup({ policy: { evaluate } });

    expect(await codeOf(guard.write({ namespace: "n", key: "k" }, value))).toBe("MEMORY_INVALID_VALUE");
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("rejects circular values", async () => {
    const { guard } = setup();
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(await codeOf(guard.write({ namespace: "n", key: "k" }, circular))).toBe("MEMORY_INVALID_VALUE");
  });

  it("rejects values whose toJSON throws", async () => {
    const { guard } = setup();
    const hostile = {
      toJSON() {
        throw new Error("boom");
      }
    };

    expect(await codeOf(guard.write({ namespace: "n", key: "k" }, hostile))).toBe("MEMORY_INVALID_VALUE");
  });

  it("enforces the serialized size limit in bytes, not characters", async () => {
    const { guard } = setup({ maxValueBytes: 16 });
    const address = { namespace: "n", key: "k" };

    // Serialized size includes the two JSON quotes. The limit is inclusive.
    await expect(guard.write(address, "abcdefghijklmn")).resolves.toBeUndefined(); // exactly 16 bytes
    expect(await codeOf(guard.write(address, "abcdefghijklmno"))).toBe("MEMORY_INVALID_VALUE"); // 17 bytes
    // 4 three-byte characters = 12 + 2 quotes = 14 bytes (allowed, though only 4 characters);
    // 5 characters = 17 bytes (rejected although 5 characters is far below 16).
    await expect(guard.write(address, "日日日日")).resolves.toBeUndefined();
    expect(await codeOf(guard.write(address, "日日日日日"))).toBe("MEMORY_INVALID_VALUE");
  });

  it("allows null as a stored value (indistinguishable from missing on read, per MemoryPort)", async () => {
    const { guard } = setup();
    const address = { namespace: "n", key: "k" };

    await guard.write(address, null);

    expect(await guard.read(address)).toBeNull();
  });
});

describe("GuardedMemoryPort — backend failures", () => {
  function failingStore(failures: Partial<Record<"read" | "write" | "delete", unknown>>): MemoryPort {
    return {
      read: async () => {
        if ("read" in failures) throw failures.read;
        return null;
      },
      write: async () => {
        if ("write" in failures) throw failures.write;
      },
      delete: async () => {
        if ("delete" in failures) throw failures.delete;
      }
    };
  }

  it("wraps backend errors generically, keeps the cause, and emits a failure event", async () => {
    const cause = new Error("disk path /secret/location unavailable");
    const { guard, failed } = setup({ store: failingStore({ write: cause }) });

    const error = await guard
      .write({ namespace: "n", key: "k" }, "v")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MemoryAccessError);
    expect((error as MemoryAccessError).code).toBe("MEMORY_BACKEND_FAILED");
    expect((error as Error).message).not.toContain("/secret/location");
    expect((error as Error).cause).toBe(cause);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ operation: "write", namespace: "n", key: "k", errorName: "Error" });
    expect(JSON.stringify(failed)).not.toContain("/secret/location");
  });

  it("handles non-Error rejections from the backend", async () => {
    const { guard, failed } = setup({ store: failingStore({ delete: "plain string" }) });

    expect(await codeOf(guard.delete({ namespace: "n", key: "k" }))).toBe("MEMORY_BACKEND_FAILED");
    expect(failed[0]?.errorName).toBe("UnknownError");
  });

  it("does not let a failing failure-event publish mask the backend failure", async () => {
    const bus = new InMemoryEventBus();
    bus.subscribe(MEMORY_ACCESS_DECIDED_EVENT, () => undefined);
    const events: EventBusPort = {
      subscribe: bus.subscribe.bind(bus),
      hasSubscribers: bus.hasSubscribers.bind(bus),
      publish: async (type, payload) => {
        if (type === MEMORY_ACCESS_FAILED_EVENT) throw new Error("audit sink down");
        await bus.publish(type, payload);
      }
    };
    const { guard } = setup({ store: failingStore({ read: new Error("down") }), events });

    expect(await codeOf(guard.read({ namespace: "n", key: "k" }))).toBe("MEMORY_BACKEND_FAILED");
  });

  it.each([
    ["a non-string value", { not: "a string" }],
    ["undefined", undefined],
    ["invalid JSON", "{not json"]
  ])("treats %s from the backing store as backend corruption", async (_label, stored) => {
    const store: MemoryPort = {
      read: async () => stored,
      write: async () => undefined,
      delete: async () => undefined
    };
    const { guard, failed } = setup({ store });

    expect(await codeOf(guard.read({ namespace: "n", key: "k" }))).toBe("MEMORY_BACKEND_FAILED");
    expect(failed).toHaveLength(1);
  });
});

describe("GuardedMemoryPort — construction", () => {
  const base = () => ({
    store: new InMemoryMemoryStore(),
    policy: allowAll,
    events: new InMemoryEventBus(),
    scope: scopeA
  });

  it.each([
    ["empty tenantId", { ...scopeA, tenantId: "" }],
    ["blank actorId", { ...scopeA, actorId: "  " }],
    ["control character in moduleId", { ...scopeA, moduleId: "m\u0000" }],
    ["over-long tenantId", { ...scopeA, tenantId: "t".repeat(129) }],
    ["non-string tenantId", { ...scopeA, tenantId: 1 as unknown as string }]
  ])("rejects an invalid scope (%s)", (_label, scope) => {
    let caught: unknown;
    try {
      new GuardedMemoryPort({ ...base(), scope });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MemoryAccessError);
    expect((caught as MemoryAccessError).code).toBe("MEMORY_INVALID_SCOPE");
  });

  it("rejects a missing scope", () => {
    expect(() => new GuardedMemoryPort({ ...base(), scope: undefined as never })).toThrow(MemoryAccessError);
  });

  it("rejects missing or malformed dependencies", () => {
    expect(() => new GuardedMemoryPort({ ...base(), store: {} as never })).toThrow(TypeError);
    expect(() => new GuardedMemoryPort({ ...base(), policy: {} as never })).toThrow(TypeError);
    expect(() => new GuardedMemoryPort({ ...base(), events: {} as never })).toThrow(TypeError);
    expect(() => new GuardedMemoryPort(undefined as never)).toThrow(TypeError);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects maxValueBytes = %s",
    (maxValueBytes) => {
      expect(() => new GuardedMemoryPort({ ...base(), maxValueBytes })).toThrow(TypeError);
    }
  );

  it("snapshots the scope so later mutation of the caller's object has no effect", async () => {
    const mutable = { ...scopeA };
    const store = new InMemoryMemoryStore();
    const events = new InMemoryEventBus();
    events.subscribe(MEMORY_ACCESS_DECIDED_EVENT, () => undefined);
    const guard = new GuardedMemoryPort({ ...base(), store, events, scope: mutable });

    mutable.tenantId = "tenant-b";
    await guard.write({ namespace: "n", key: "k" }, 1);

    expect(store.addresses()[0]?.namespace.startsWith("tenant-a/")).toBe(true);
  });
});

describe("GuardedMemoryPort — Core Engine integration", () => {
  it("is usable as the module memory capability under a real policy", async () => {
    const store = new InMemoryMemoryStore();
    const events = new InMemoryEventBus();
    events.subscribe(MEMORY_ACCESS_DECIDED_EVENT, () => undefined);
    const policy: PolicyEngine = {
      evaluate: async (request) =>
        request.action === "memory.write" || request.action === "memory.read"
          ? { effect: "allow", reason: "module memory permitted" }
          : { effect: "deny", reason: "not permitted" }
    };
    const engine = new CoreEngine({
      events,
      policy,
      memory: (moduleId) =>
        new GuardedMemoryPort({
          store,
          policy,
          events,
          scope: { ...scopeA, moduleId }
        })
    });
    const observed: unknown[] = [];

    engine.register({
      id: "notes",
      version: "1.0.0",
      initialize: async (context) => {
        await context.memory?.write({ namespace: "notes", key: "greeting" }, { text: "hello" });
      },
      start: async (context) => {
        observed.push(await context.memory?.read({ namespace: "notes", key: "greeting" }));
        observed.push(await codeOf(context.memory!.delete({ namespace: "notes", key: "greeting" })));
      }
    });

    await engine.initialize();
    await engine.start();
    await engine.stop();

    expect(observed).toEqual([{ text: "hello" }, "MEMORY_ACCESS_DENIED"]);
  });
});
