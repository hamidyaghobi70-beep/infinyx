import type { MemoryAddress, MemoryPort } from "./contracts.js";

interface StoredEntry {
  readonly address: MemoryAddress;
  readonly value: unknown;
}

/**
 * Reference backing store for tests and local composition only.
 *
 * It is NOT durable, NOT encrypted and has no retention or backup behavior. It
 * performs no authorization: always place it behind GuardedMemoryPort. It must not
 * be used for sensitive workloads.
 */
export class InMemoryMemoryStore implements MemoryPort {
  private readonly entries = new Map<string, StoredEntry>();

  async read(address: MemoryAddress): Promise<unknown | null> {
    const entry = this.entries.get(entryKey(address));
    return entry === undefined ? null : entry.value;
  }

  async write(address: MemoryAddress, value: unknown): Promise<void> {
    this.entries.set(entryKey(address), {
      address: Object.freeze({ namespace: address.namespace, key: address.key }),
      value
    });
  }

  async delete(address: MemoryAddress): Promise<void> {
    this.entries.delete(entryKey(address));
  }

  get size(): number {
    return this.entries.size;
  }

  /** Diagnostic view of the raw backing addresses (used to verify isolation in tests). */
  addresses(): readonly MemoryAddress[] {
    return [...this.entries.values()].map((entry) => entry.address);
  }
}

function entryKey(address: MemoryAddress): string {
  // JSON tuple encoding keeps (namespace, key) pairs unambiguous.
  return JSON.stringify([address.namespace, address.key]);
}
