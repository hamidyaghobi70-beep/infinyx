import { describe, expect, it, vi } from "vitest";
import type { MemoryAddress, MemoryPort } from "../../src/core/contracts.js";
import {
  MemoryDeletionCoordinator,
  type MemoryDeletionLedgerPort,
  type MemoryDeletionTombstone
} from "../../src/core/memory-deletion-replay.js";

class FakeStore implements MemoryPort {
  readonly values = new Map<string, unknown>();
  readonly deleted: MemoryAddress[] = [];
  async read(address: MemoryAddress) { return this.values.get(key(address)) ?? null; }
  async write(address: MemoryAddress, value: unknown) { this.values.set(key(address), value); }
  async delete(address: MemoryAddress) { this.values.delete(key(address)); this.deleted.push(address); }
}
class FakeLedger implements MemoryDeletionLedgerPort {
  readonly entries: MemoryDeletionTombstone[] = [];
  failAppend = false;
  private next = 0;
  async append(entry: Omit<MemoryDeletionTombstone, "id">) {
    if (this.failAppend) throw new Error("external ledger unavailable");
    const id = String(++this.next).padStart(4, "0");
    this.entries.push({ ...entry, id });
    return id;
  }
  async listAfter(cursor: string | null, limit: number) {
    return this.entries.filter((entry) => cursor === null || entry.id > cursor).slice(0, limit);
  }
}
const key = (address: MemoryAddress) => address.namespace + "/" + address.key;

describe("MemoryDeletionCoordinator", () => {
  it("snapshots store and ledger capabilities against replacement and instance tampering", async () => {
    const store = new FakeStore();
    const ledger = new FakeLedger();
    const address = { namespace: "tenant-a", key: "protected" };
    await store.write(address, "secret");
    const originalDelete = vi.spyOn(store, "delete");
    const originalAppend = vi.spyOn(ledger, "append");
    const originalListAfter = vi.spyOn(ledger, "listAfter");
    const coordinator = new MemoryDeletionCoordinator(store, ledger);

    store.delete = vi.fn(async () => undefined);
    ledger.append = vi.fn(async () => "forged-cursor");
    ledger.listAfter = vi.fn(async () => []);
    (coordinator as unknown as Record<string, unknown>).store = new FakeStore();
    (coordinator as unknown as Record<string, unknown>).ledger = new FakeLedger();

    await coordinator.delete(address, "user_request");
    expect(originalAppend).toHaveBeenCalledTimes(1);
    expect(originalDelete).toHaveBeenCalledTimes(1);
    expect(ledger.entries).toHaveLength(1);
    expect(await store.read(address)).toBeNull();

    await store.write(address, "restored-secret");
    await coordinator.replayAfterRestore();
    expect(originalListAfter).toHaveBeenCalled();
    expect(await store.read(address)).toBeNull();
    expect(Object.isFrozen(coordinator)).toBe(true);
    expect(Reflect.ownKeys(coordinator)).toEqual([]);
  });

  it("snapshots accessor-backed deletion addresses before validation and use", async () => {
    const store = new FakeStore();
    const ledger = new FakeLedger();
    const target = { namespace: "tenant-a", key: "stable" };
    await store.write(target, "secret");
    let namespaceReads = 0;
    let keyReads = 0;
    const address = {
      get namespace() { namespaceReads += 1; return namespaceReads === 1 ? "tenant-a" : "attacker"; },
      get key() { keyReads += 1; return keyReads === 1 ? "stable" : "other"; }
    } as MemoryAddress;
    const coordinator = new MemoryDeletionCoordinator(store, ledger);
    await coordinator.delete(address);
    expect(namespaceReads).toBe(1);
    expect(keyReads).toBe(1);
    expect(ledger.entries[0]).toMatchObject({ namespace: "tenant-a", key: "stable" });
    expect(await store.read(target)).toBeNull();
    expect(await store.read({ namespace: "attacker", key: "other" })).toBeNull();
  });

  it("snapshots every ledger tombstone field before applying the page", async () => {
    const store = new FakeStore();
    let namespaceReads = 0;
    const tombstone = {
      id: "cursor-1",
      get namespace() { namespaceReads += 1; return namespaceReads === 1 ? "tenant-a" : "attacker"; },
      key: "protected",
      deletedAt: "2026-11-23T12:00:00.000Z",
      reason: "user_request" as const
    } as MemoryDeletionTombstone;
    const ledger: MemoryDeletionLedgerPort = {
      append: vi.fn(async () => "cursor-1"),
      listAfter: vi.fn(async () => [tombstone])
    };
    const coordinator = new MemoryDeletionCoordinator(store, ledger);
    await coordinator.replayAfterRestore();
    expect(namespaceReads).toBe(1);
    expect(store.deleted).toEqual([{ namespace: "tenant-a", key: "protected" }]);
  });

  it("persists an external tombstone before deleting live memory", async () => {
    const store = new FakeStore();
    const ledger = new FakeLedger();
    await store.write({ namespace: "tenant-a", key: "k" }, "secret");
    const coordinator = new MemoryDeletionCoordinator(store, ledger, {
      now: () => new Date("2026-11-23T12:00:00.000Z")
    });
    await coordinator.delete({ namespace: "tenant-a", key: "k" }, "user_request");
    expect(ledger.entries).toHaveLength(1);
    expect(await store.read({ namespace: "tenant-a", key: "k" })).toBeNull();
    expect(ledger.entries[0]?.reason).toBe("user_request");
  });

  it("rejects unsupported deletion reasons before writing a tombstone or deleting memory", async () => {
    const store = new FakeStore();
    const ledger = new FakeLedger();
    const address = { namespace: "tenant-a", key: "k" };
    await store.write(address, "secret");
    const coordinator = new MemoryDeletionCoordinator(store, ledger);
    await expect(coordinator.delete(address, "unknown" as never))
      .rejects.toThrow("supported memory deletion reason");
    expect(ledger.entries).toHaveLength(0);
    expect(store.deleted).toHaveLength(0);
    expect(await store.read(address)).toBe("secret");
  });

  it("fails closed when the external ledger cannot persist a tombstone", async () => {
    const store = new FakeStore();
    const ledger = new FakeLedger();
    ledger.failAppend = true;
    await store.write({ namespace: "tenant-a", key: "k" }, "secret");
    const coordinator = new MemoryDeletionCoordinator(store, ledger);
    await expect(coordinator.delete({ namespace: "tenant-a", key: "k" })).rejects.toThrow("external ledger unavailable");
    expect(await store.read({ namespace: "tenant-a", key: "k" })).toBe("secret");
  });

  it("replays all tombstones in bounded pages and is safe to repeat after restore", async () => {
    const store = new FakeStore();
    const ledger = new FakeLedger();
    const a = { namespace: "tenant-a", key: "a" };
    const b = { namespace: "tenant-b", key: "b" };
    await store.write(a, "one");
    await store.write(b, "two");
    await ledger.append({ ...a, deletedAt: "2026-11-23T12:00:00.000Z", reason: "user_request" });
    await ledger.append({ ...b, deletedAt: "2026-11-23T12:00:01.000Z", reason: "retention_expiry" });
    const coordinator = new MemoryDeletionCoordinator(store, ledger, { batchSize: 1 });
    await expect(coordinator.replayAfterRestore()).resolves.toEqual({ recorded: "0002", replayed: 2, batches: 2 });
    expect(await store.read(a)).toBeNull();
    expect(await store.read(b)).toBeNull();
    await expect(coordinator.replayAfterRestore()).resolves.toEqual({ recorded: "0002", replayed: 2, batches: 2 });
  });

  it("treats opaque ledger cursors as append-order tokens, not sortable strings", async () => {
    const store = new FakeStore();
    const ledger: MemoryDeletionLedgerPort = {
      append: vi.fn(async () => "cursor-z"),
      listAfter: vi.fn()
        .mockResolvedValueOnce([
          { id: "cursor-z", namespace: "tenant-a", key: "a", deletedAt: "2026-11-23T12:00:00.000Z", reason: "user_request" }
        ])
        .mockResolvedValueOnce([
          { id: "cursor-a", namespace: "tenant-b", key: "b", deletedAt: "2026-11-23T12:00:01.000Z", reason: "policy" }
        ])
        .mockResolvedValueOnce([])
    };
    const coordinator = new MemoryDeletionCoordinator(store, ledger, { batchSize: 1 });
    await expect(coordinator.replayAfterRestore()).resolves.toEqual({
      recorded: "cursor-a", replayed: 2, batches: 2
    });
    expect(ledger.listAfter).toHaveBeenNthCalledWith(2, "cursor-z", 1);
  });

  it("rejects repeated or duplicate opaque cursors", async () => {
    const store = new FakeStore();
    const ledger: MemoryDeletionLedgerPort = {
      append: vi.fn(async () => "cursor-1"),
      listAfter: vi.fn(async () => [
        { id: "cursor-1", namespace: "tenant-a", key: "a", deletedAt: "2026-11-23T12:00:00.000Z", reason: "user_request" },
        { id: "cursor-1", namespace: "tenant-b", key: "b", deletedAt: "2026-11-23T12:00:01.000Z", reason: "policy" }
      ])
    };
    const coordinator = new MemoryDeletionCoordinator(store, ledger);
    await expect(coordinator.replayAfterRestore()).rejects.toThrow("repeated a cursor");
  });

  it("rejects a cursor repeated across pages before applying the repeated page", async () => {
    const store = new FakeStore();
    const first = { id: "cursor-z", namespace: "tenant-a", key: "a", deletedAt: "2026-11-23T12:00:00.000Z", reason: "user_request" as const };
    const ledger: MemoryDeletionLedgerPort = {
      append: vi.fn(async () => "cursor-z"),
      listAfter: vi.fn()
        .mockResolvedValueOnce([first])
        .mockResolvedValueOnce([first])
    };
    const coordinator = new MemoryDeletionCoordinator(store, ledger, { batchSize: 1 });
    await expect(coordinator.replayAfterRestore()).rejects.toThrow("repeated a cursor");
    expect(store.deleted).toEqual([{ namespace: "tenant-a", key: "a" }]);
  });

  it("validates an entire page before applying any deletion", async () => {
    const store = new FakeStore();
    const ledger: MemoryDeletionLedgerPort = {
      append: vi.fn(async () => "cursor-2"),
      listAfter: vi.fn(async () => [
        { id: "cursor-1", namespace: "tenant-a", key: "a", deletedAt: "2026-11-23T12:00:00.000Z", reason: "user_request" },
        { id: "cursor-2", namespace: "tenant-b", key: "b", deletedAt: "invalid-date", reason: "policy" }
      ])
    };
    const coordinator = new MemoryDeletionCoordinator(store, ledger, { batchSize: 2 });
    await expect(coordinator.replayAfterRestore()).rejects.toThrow("malformed tombstone");
    expect(store.deleted).toHaveLength(0);
  });

  it("does not invoke a ledger page's overridden map method", async () => {
    const store = new FakeStore();
    const entry = { id: "cursor-1", namespace: "tenant-a", key: "k",
      deletedAt: "2026-11-23T12:00:00.000Z", reason: "user_request" as const };
    const page = [entry] as MemoryDeletionTombstone[];
    Object.defineProperty(page, "map", {
      configurable: true,
      get() { throw new Error("untrusted page map getter invoked"); }
    });
    const ledger: MemoryDeletionLedgerPort = {
      append: vi.fn(async () => "cursor-1"),
      listAfter: vi.fn(async () => page)
    };
    const coordinator = new MemoryDeletionCoordinator(store, ledger);
    await coordinator.replayAfterRestore();
    expect(store.deleted).toEqual([{ namespace: "tenant-a", key: "k" }]);
  });

  it("rejects malformed ledger pages", async () => {
    const store = new FakeStore();
    const ledger = new FakeLedger();
    vi.spyOn(ledger, "listAfter").mockResolvedValue([
      { id: "0002", namespace: "tenant-a", key: "k", deletedAt: "not-a-date", reason: "user_request" }
    ]);
    const coordinator = new MemoryDeletionCoordinator(store, ledger);
    await expect(coordinator.replayAfterRestore()).rejects.toThrow("malformed tombstone");
  });
});
