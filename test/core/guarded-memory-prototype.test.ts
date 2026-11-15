import { describe, expect, it } from "vitest";
import { InMemoryEventBus } from "../../src/core/event-bus.js";
import {
  GuardedMemoryPort,
  MEMORY_ACCESS_DECIDED_EVENT
} from "../../src/core/guarded-memory-port.js";
import type {
  MemoryAuditPort,
  MemoryScope
} from "../../src/core/guarded-memory-port.js";
import { InMemoryMemoryStore } from "../../src/core/in-memory-memory-store.js";

describe("GuardedMemoryPort prototype integrity", () => {
  it("prevents modules from replacing shared guarded methods through the prototype", async () => {
    const store = new InMemoryMemoryStore();
    const bus = new InMemoryEventBus();
    const audit: MemoryAuditPort = {
      publishDecision: async () => {
        await bus.publish(MEMORY_ACCESS_DECIDED_EVENT, {});
        return true;
      },
      publishFailure: async () => undefined
    };
    const scope: MemoryScope = {
      tenantId: "tenant-a",
      actorId: "actor-a",
      moduleId: "module-a"
    };
    const guard = new GuardedMemoryPort({
      store,
      policy: { evaluate: async () => ({ effect: "allow", reason: "test" }) },
      audit,
      scope
    });

    expect(Object.isFrozen(GuardedMemoryPort.prototype)).toBe(true);
    expect(Reflect.set(
      GuardedMemoryPort.prototype,
      "write",
      async () => undefined
    )).toBe(false);

    await expect(
      guard.write({ namespace: "notes", key: "entry" }, { safe: true })
    ).resolves.toBeUndefined();
    expect(store.size).toBe(1);
  });
});
