import type { MemoryAddress, MemoryPort } from "./contracts.js";

/**
 * A tombstone is an independently durable deletion instruction.
 * The ledger implementation MUST live outside the PostgreSQL backup/restore
 * failure domain (for example, a separately administered immutable log).
 */
export interface MemoryDeletionTombstone {
  readonly id: string;
  readonly namespace: string;
  readonly key: string;
  readonly deletedAt: string;
  readonly reason: "user_request" | "retention_expiry" | "policy";
}

export interface MemoryDeletionLedgerPort {
  /**
   * Must durably append before resolving and return a strictly increasing,
   * opaque ledger sequence cursor (not a client-generated random identifier).
   */
  append(tombstone: Omit<MemoryDeletionTombstone, "id">): Promise<string>;
  /** Returns entries in append order, strictly after the supplied opaque sequence cursor. */
  listAfter(cursor: string | null, limit: number): Promise<readonly MemoryDeletionTombstone[]>;
}

export interface MemoryDeletionReplayOptions {
  readonly batchSize?: number;
  readonly now?: () => Date;
}

export interface MemoryDeletionReplayResult {
  readonly recorded: string;
  readonly replayed: number;
  readonly batches: number;
}

/**
 * Coordinates delete-before-restore-replay using an external durable tombstone
 * ledger. A deletion is recorded first; only then is the live store mutated.
 * Replaying is idempotent and deliberately starts from the beginning so it can
 * be run after every restore without maintaining a cursor in the restored DB.
 */
export class MemoryDeletionCoordinator implements MemoryPort {
  readonly #batchSize: number;
  readonly #now: () => Date;

  constructor(
    private readonly store: MemoryPort,
    private readonly ledger: MemoryDeletionLedgerPort,
    options: MemoryDeletionReplayOptions = {}
  ) {
    this.#batchSize = options.batchSize ?? 250;
    this.#now = options.now ?? (() => new Date());
    if (!Number.isSafeInteger(this.#batchSize) || this.#batchSize < 1 || this.#batchSize > 5000) {
      throw new TypeError("batchSize must be an integer between 1 and 5000.");
    }
  }

  /** Delegate reads/writes unchanged so this coordinator can sit beneath GuardedMemoryPort. */
  read(address: MemoryAddress): Promise<unknown | null> {
    return this.store.read(address);
  }

  write(address: MemoryAddress, value: unknown): Promise<void> {
    return this.store.write(address, value);
  }

  async delete(
    address: MemoryAddress,
    reason: MemoryDeletionTombstone["reason"] = "user_request"
  ): Promise<void> {
    validateAddress(address);
    const tombstone = Object.freeze({
      namespace: address.namespace,
      key: address.key,
      deletedAt: this.#now().toISOString(),
      reason
    });
    // Fail closed: if the independent ledger is unavailable, do not delete.
    const cursor = await this.ledger.append(tombstone);
    if (typeof cursor !== "string" || cursor.length < 1 || cursor.length > 512) {
      throw new Error("Deletion ledger returned an invalid append cursor.");
    }
    await this.store.delete({ namespace: address.namespace, key: address.key });
  }

  async replayAfterRestore(): Promise<MemoryDeletionReplayResult> {
    let cursor: string | null = null;
    let replayed = 0;
    let batches = 0;
    for (;;) {
      const entries = await this.ledger.listAfter(cursor, this.#batchSize);
      if (entries.length === 0) break;
      if (entries.length > this.#batchSize) {
        throw new Error("Deletion ledger exceeded the requested page size.");
      }
      const pageIds = new Set<string>();
      for (const entry of entries) {
        validateTombstone(entry);
        // Cursors are opaque: never compare them lexicographically or numerically.
        // The ledger contract owns append ordering; the coordinator enforces progress
        // and rejects duplicate/repeated cursors to prevent an infinite replay loop.
        if (entry.id === cursor || pageIds.has(entry.id)) {
          throw new Error("Deletion ledger pagination repeated a cursor.");
        }
        pageIds.add(entry.id);
        await this.store.delete({ namespace: entry.namespace, key: entry.key });
        replayed += 1;
      }
      cursor = entries[entries.length - 1]!.id;
      batches += 1;
      if (entries.length < this.#batchSize) break;
    }
    return Object.freeze({ recorded: cursor ?? "", replayed, batches });
  }
}

function validateAddress(address: MemoryAddress): void {
  if (!address || typeof address.namespace !== "string" || !address.namespace ||
      typeof address.key !== "string" || !address.key) {
    throw new TypeError("A valid memory namespace and key are required.");
  }
}

function validateTombstone(value: MemoryDeletionTombstone): void {
  if (!value || typeof value.id !== "string" || !value.id ||
      typeof value.namespace !== "string" || !value.namespace ||
      typeof value.key !== "string" || !value.key ||
      typeof value.deletedAt !== "string" || !Number.isFinite(Date.parse(value.deletedAt)) ||
      !["user_request", "retention_expiry", "policy"].includes(value.reason)) {
    throw new Error("Deletion ledger returned a malformed tombstone.");
  }
}
