import { randomUUID } from "node:crypto";
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
  /** Must be durable before resolving; idempotent for the same id. */
  append(tombstone: MemoryDeletionTombstone): Promise<void>;
  /** Returns tombstones ordered by id, strictly after the supplied cursor. */
  listAfter(cursor: string | null, limit: number): Promise<readonly MemoryDeletionTombstone[]>;
}

export interface MemoryDeletionReplayOptions {
  readonly batchSize?: number;
  readonly now?: () => Date;
  readonly createId?: () => string;
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
export class MemoryDeletionCoordinator {
  readonly #batchSize: number;
  readonly #now: () => Date;
  readonly #createId: () => string;

  constructor(
    private readonly store: MemoryPort,
    private readonly ledger: MemoryDeletionLedgerPort,
    options: MemoryDeletionReplayOptions = {}
  ) {
    this.#batchSize = options.batchSize ?? 250;
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? (() => randomUUID());
    if (!Number.isSafeInteger(this.#batchSize) || this.#batchSize < 1 || this.#batchSize > 5000) {
      throw new TypeError("batchSize must be an integer between 1 and 5000.");
    }
  }

  async delete(
    address: MemoryAddress,
    reason: MemoryDeletionTombstone["reason"] = "user_request"
  ): Promise<void> {
    validateAddress(address);
    const id = this.#createId();
    if (typeof id !== "string" || id.length < 1 || id.length > 200) {
      throw new TypeError("Deletion ledger ID generator returned an invalid ID.");
    }
    const tombstone: MemoryDeletionTombstone = Object.freeze({
      id,
      namespace: address.namespace,
      key: address.key,
      deletedAt: this.#now().toISOString(),
      reason
    });
    // Fail closed: if the independent ledger is unavailable, do not delete.
    await this.ledger.append(tombstone);
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
      let previous = cursor;
      for (const entry of entries) {
        validateTombstone(entry);
        if (previous !== null && entry.id <= previous) {
          throw new Error("Deletion ledger pagination is not strictly ordered.");
        }
        await this.store.delete({ namespace: entry.namespace, key: entry.key });
        previous = entry.id;
        replayed += 1;
      }
      cursor = previous;
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
