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
  readonly #store: MemoryPort;
  readonly #ledger: MemoryDeletionLedgerPort;
  readonly #batchSize: number;
  readonly #now: () => Date;

  constructor(
    store: MemoryPort,
    ledger: MemoryDeletionLedgerPort,
    options: MemoryDeletionReplayOptions = {}
  ) {
    this.#store = captureMethods<MemoryPort>(store, ["read", "write", "delete"]);
    this.#ledger = captureMethods<MemoryDeletionLedgerPort>(ledger, ["append", "listAfter"]);
    let configuredBatchSize: unknown;
    let configuredNow: unknown;
    try {
      configuredBatchSize = options.batchSize;
      configuredNow = options.now;
    } catch {
      throw new TypeError("Deletion coordinator options must be readable.");
    }
    this.#batchSize = configuredBatchSize === undefined ? 250 : configuredBatchSize as number;
    if (!Number.isSafeInteger(this.#batchSize) || this.#batchSize < 1 || this.#batchSize > 5000) {
      throw new TypeError("batchSize must be an integer between 1 and 5000.");
    }
    if (configuredNow !== undefined && typeof configuredNow !== "function") {
      throw new TypeError("now must be a function.");
    }
    this.#now = configuredNow === undefined
      ? () => new Date()
      : (configuredNow as () => Date).bind(options);
    Object.freeze(this);
  }

  /** Delegate reads/writes unchanged so this coordinator can sit beneath GuardedMemoryPort. */
  read(address: MemoryAddress): Promise<unknown | null> {
    return this.#store.read(address);
  }

  write(address: MemoryAddress, value: unknown): Promise<void> {
    return this.#store.write(address, value);
  }

  async delete(
    address: MemoryAddress,
    reason: MemoryDeletionTombstone["reason"] = "user_request"
  ): Promise<void> {
    const target = snapshotAddress(address);
    if (!["user_request", "retention_expiry", "policy"].includes(reason)) {
      throw new TypeError("A supported memory deletion reason is required.");
    }
    const tombstone = Object.freeze({
      namespace: target.namespace,
      key: target.key,
      deletedAt: this.#now().toISOString(),
      reason
    });
    // Fail closed: if the independent ledger is unavailable, do not delete.
    const cursor = await this.#ledger.append(tombstone);
    if (typeof cursor !== "string" || cursor.length < 1 || cursor.length > 512) {
      throw new Error("Deletion ledger returned an invalid append cursor.");
    }
    await this.#store.delete(target);
  }

  async replayAfterRestore(): Promise<MemoryDeletionReplayResult> {
    let cursor: string | null = null;
    let replayed = 0;
    let batches = 0;
    const seenIds = new Set<string>();
    for (;;) {
      const entries = await this.#ledger.listAfter(cursor, this.#batchSize);
      if (!Array.isArray(entries)) {
        throw new Error("Deletion ledger returned a malformed page.");
      }
      const pageLength = entries.length;
      if (pageLength === 0) break;
      if (!Number.isSafeInteger(pageLength) || pageLength < 0 || pageLength > this.#batchSize) {
        throw new Error("Deletion ledger exceeded the requested page size.");
      }
      const pageIds = new Set<string>();
      const page: MemoryDeletionTombstone[] = [];
      for (let index = 0; index < pageLength; index += 1) {
        let entry: MemoryDeletionTombstone;
        try {
          entry = snapshotTombstone(entries[index]!);
        } catch {
          throw new Error("Deletion ledger returned a malformed tombstone.");
        }
        page.push(entry);
      }
      for (const entry of page) {
        // Cursors are opaque: never compare them lexicographically or numerically.
        // Enforce uniqueness across the entire replay, not just within one page.
        if (entry.id === cursor || pageIds.has(entry.id) || seenIds.has(entry.id)) {
          throw new Error("Deletion ledger pagination repeated a cursor.");
        }
        pageIds.add(entry.id);
      }

      // Validate and snapshot the complete page before applying any deletion.
      for (const entry of page) {
        await this.#store.delete({ namespace: entry.namespace, key: entry.key });
        replayed += 1;
      }
      for (const id of pageIds) seenIds.add(id);
      cursor = page[page.length - 1]!.id;
      batches += 1;
      if (pageLength < this.#batchSize) break;
    }
    return Object.freeze({ recorded: cursor ?? "", replayed, batches });
  }
}

function captureMethods<T extends object>(value: object, names: readonly string[]): T {
  if (!value || typeof value !== "object") throw new TypeError("Deletion coordinator dependencies must be objects.");
  const captured: Record<string, unknown> = {};
  try {
    for (const name of names) {
      const method: unknown = Reflect.get(value, name);
      if (typeof method !== "function") throw new TypeError("Dependency method must be a function.");
      captured[name] = method.bind(value);
    }
  } catch {
    throw new TypeError("Deletion coordinator dependency methods must be readable functions.");
  }
  return Object.freeze(captured) as T;
}

function snapshotAddress(address: MemoryAddress): MemoryAddress {
  let namespace: unknown;
  let key: unknown;
  try { namespace = address?.namespace; key = address?.key; }
  catch { throw new TypeError("A valid memory namespace and key are required."); }
  if (typeof namespace !== "string" || !namespace || typeof key !== "string" || !key) {
    throw new TypeError("A valid memory namespace and key are required.");
  }
  return Object.freeze({ namespace, key });
}

function snapshotTombstone(value: MemoryDeletionTombstone): MemoryDeletionTombstone {
  let id: unknown; let namespace: unknown; let key: unknown; let deletedAt: unknown; let reason: unknown;
  try {
    id = value?.id; namespace = value?.namespace; key = value?.key;
    deletedAt = value?.deletedAt; reason = value?.reason;
  } catch { throw new Error("Deletion ledger returned a malformed tombstone."); }
  if (typeof id !== "string" || !id || typeof namespace !== "string" || !namespace ||
      typeof key !== "string" || !key || typeof deletedAt !== "string" || !Number.isFinite(Date.parse(deletedAt)) ||
      !["user_request", "retention_expiry", "policy"].includes(reason as string)) {
    throw new Error("Deletion ledger returned a malformed tombstone.");
  }
  return Object.freeze({ id, namespace, key, deletedAt, reason }) as MemoryDeletionTombstone;
}
