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
