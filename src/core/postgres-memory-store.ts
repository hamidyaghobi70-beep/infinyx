import type { MemoryAddress, MemoryPort } from "./contracts.js";
import { MemoryValueCipher, type EncryptedMemoryEnvelope, type MemoryEncryptionContext } from "./memory-encryption.js";

export interface SqlQueryResult<Row> {
  readonly rows: readonly Row[];
  readonly rowCount?: number | null;
}

/** Structural subset implemented by pg.Pool and pg.Client; no driver is coupled to Core. */
export interface SqlExecutor {
  query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<SqlQueryResult<Row>>;
}

export interface StoredMemoryEnvelope extends EncryptedMemoryEnvelope {
  readonly schemaVersion: 1;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string;
  readonly classification: "public" | "internal" | "confidential";
}

export interface PostgresMemoryStoreOptions {
  readonly tableName?: "infinyx_memory.memory_entries";
  readonly retentionDays?: number;
  readonly now?: () => Date;
}

/**
 * PostgreSQL-backed encrypted MemoryPort. Place behind GuardedMemoryPort.
 * Namespace values supplied by GuardedMemoryPort already contain an unambiguous tenant prefix.
 */
export class PostgresEncryptedMemoryStore implements MemoryPort {
  readonly #table: string;
  readonly #retentionDays: number;
  readonly #now: () => Date;

  constructor(
    private readonly db: SqlExecutor,
    private readonly cipher: MemoryValueCipher,
    options: PostgresMemoryStoreOptions = {}
  ) {
    if (options.tableName !== undefined && options.tableName !== "infinyx_memory.memory_entries") {
      throw new TypeError("Unsupported persistent memory table.");
    }
    this.#table = options.tableName ?? "infinyx_memory.memory_entries";
    this.#retentionDays = options.retentionDays ?? 90;
    this.#now = options.now ?? (() => new Date());
    if (!Number.isSafeInteger(this.#retentionDays) || this.#retentionDays < 1 || this.#retentionDays > 3650) {
      throw new TypeError("retentionDays must be an integer between 1 and 3650.");
    }
  }

  async read(address: MemoryAddress): Promise<unknown | null> {
    const target = snapshotMemoryAddress(address);
    const tenantId = tenantFromScopedNamespace(target.namespace);
    const result = await this.db.query<{ envelope: StoredMemoryEnvelope; expires_at: Date | string }>(
      `SELECT envelope, expires_at FROM ${this.#table}
       WHERE tenant_id = $1 AND namespace = $2 AND memory_key = $3 LIMIT 1`,
      [tenantId, target.namespace, target.key]
    );
    const row = result.rows[0];
    if (!row) return null;
    const expiresAt = new Date(row.expires_at).getTime();
    if (!Number.isFinite(expiresAt)) {
      throw new Error("Persistent memory record has an invalid expiry timestamp.");
    }
    if (expiresAt <= this.#now().getTime()) {
      // The row may have been refreshed after SELECT. Delete only the exact
      // expired version observed above; an unconditional delete can erase a
      // concurrent write that extended the record's retention window.
      const deletion = await this.db.query(
        `DELETE FROM ${this.#table}
         WHERE tenant_id = $1 AND namespace = $2 AND memory_key = $3
           AND expires_at = $4 AND envelope = $5::jsonb`,
        [tenantId, target.namespace, target.key, row.expires_at, JSON.stringify(row.envelope)]
      );
      if ((deletion.rowCount ?? 0) > 0) return null;

      // A zero-row conditional delete means the observed version changed (or
      // another reader removed it). Re-read once so a concurrent refresh is
      // visible to this caller instead of being reported as a false cache miss.
      const refreshed = await this.db.query<{ envelope: StoredMemoryEnvelope; expires_at: Date | string }>(
        `SELECT envelope, expires_at FROM ${this.#table}
         WHERE tenant_id = $1 AND namespace = $2 AND memory_key = $3 LIMIT 1`,
        [tenantId, target.namespace, target.key]
      );
      const current = refreshed.rows[0];
      if (!current) return null;
      const currentExpiresAt = new Date(current.expires_at).getTime();
      if (!Number.isFinite(currentExpiresAt)) {
        throw new Error("Persistent memory record has an invalid expiry timestamp.");
      }
      if (currentExpiresAt <= this.#now().getTime()) return null;
      return this.cipher.decrypt(current.envelope, encryptionContext(target, tenantId));
    }
    return this.cipher.decrypt(row.envelope, encryptionContext(target, tenantId));
  }

  async write(address: MemoryAddress, value: unknown): Promise<void> {
    const target = snapshotMemoryAddress(address);
    if (typeof value !== "string") throw new TypeError("GuardedMemoryPort must provide serialized JSON strings.");
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { throw new TypeError("Persistent memory values must be valid classified JSON."); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError("Persistent memory values must be JSON objects with an explicit classification.");
    }
    const classification = (parsed as { classification?: unknown }).classification;
    if (classification !== "public" && classification !== "internal" && classification !== "confidential") {
      // Restricted and unclassified values are denied by default.
      throw new TypeError("Persistent memory classification is missing, unsupported, or restricted.");
    }
    const tenantId = tenantFromScopedNamespace(target.namespace);
    const encrypted = await this.cipher.encrypt(value, encryptionContext(target, tenantId));
    const now = this.#now();
    const expiresAt = new Date(now.getTime() + this.#retentionDays * 24 * 60 * 60 * 1000);
    const envelope: StoredMemoryEnvelope = Object.freeze({
      ...encrypted,
      schemaVersion: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      classification
    });
    await this.db.query(
      `INSERT INTO ${this.#table} (tenant_id, namespace, memory_key, envelope, classification, created_at, updated_at, expires_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $6, $7)
       ON CONFLICT (tenant_id, namespace, memory_key) DO UPDATE SET
         envelope = EXCLUDED.envelope, classification = EXCLUDED.classification, created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at, expires_at = EXCLUDED.expires_at`,
      [tenantId, target.namespace, target.key, JSON.stringify(envelope), classification, now, expiresAt]
    );
  }

  async delete(address: MemoryAddress): Promise<void> {
    const target = snapshotMemoryAddress(address);
    const tenantId = tenantFromScopedNamespace(target.namespace);
    await this.db.query(`DELETE FROM ${this.#table} WHERE tenant_id = $1 AND namespace = $2 AND memory_key = $3`, [
      tenantId, target.namespace, target.key
    ]);
  }

  /**
   * Re-encrypt a bounded batch with the provider's active key.
   * The JSONB equality predicate is an optimistic concurrency guard: a concurrent
   * application write wins and is never overwritten by a stale rotation pass.
   */
  async reencryptBatch(batchSize = 100): Promise<{ readonly examined: number; readonly rotated: number }> {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
      throw new TypeError("batchSize must be between 1 and 1000.");
    }
    const activeKeyId = await this.cipher.activeKeyId();
    const selected = await this.db.query<{
      tenant_id: string;
      namespace: string;
      memory_key: string;
      envelope: StoredMemoryEnvelope;
    }>(
      `SELECT tenant_id, namespace, memory_key, envelope
       FROM ${this.#table}
       WHERE envelope->>'keyId' IS DISTINCT FROM $1
          OR envelope->>'formatVersion' IS DISTINCT FROM '2'
       ORDER BY updated_at
       LIMIT $2`,
      [activeKeyId, batchSize]
    );
    let rotated = 0;
    const failures: unknown[] = [];
    for (const row of selected.rows) {
      try {
        const context = encryptionContext({ namespace: row.namespace, key: row.memory_key }, row.tenant_id);
        const encrypted = await this.cipher.reencrypt(row.envelope, context);
        const updatedAt = this.#now();
        const result = await this.db.query(
          `UPDATE ${this.#table}
           SET envelope = $1::jsonb, updated_at = $2
           WHERE tenant_id = $3 AND namespace = $4 AND memory_key = $5 AND envelope = $6::jsonb`,
          [JSON.stringify({ ...encrypted, schemaVersion: row.envelope.schemaVersion,
            createdAt: row.envelope.createdAt, updatedAt: updatedAt.toISOString(),
            expiresAt: row.envelope.expiresAt, classification: row.envelope.classification }),
            updatedAt, row.tenant_id, row.namespace, row.memory_key, JSON.stringify(row.envelope)]
        );
        if ((result.rowCount ?? 0) === 1) rotated += 1;
      } catch (error) {
        // Continue through this bounded batch, but never hide a failed record.
        // Operators must alert and quarantine/reconcile the reported failures.
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Memory key rotation examined ${selected.rows.length} record(s), rotated ${rotated}, and encountered ${failures.length} failure(s).`
      );
    }
    return { examined: selected.rows.length, rotated };
  }

  /**
   * Expiry purges must be recorded by the independent deletion ledger so a
   * restore cannot resurrect expired records. This adapter has no ledger
   * dependency; fail closed rather than offering an unaudited destructive path.
   */
  async deleteExpired(_batchSize = 500): Promise<number> {
    throw new Error("Expiry deletion requires a deletion-ledger coordinator.");
  }
}


/**
 * GuardedMemoryPort encodes the authenticated tenant as the first namespace
 * segment. Persist it separately so every point query is tenant-qualified.
 * This is defense in depth, not authentication: the composition root must still
 * derive the namespace from a trusted principal.
 */
function snapshotMemoryAddress(address: MemoryAddress): MemoryAddress {
  let namespace: unknown;
  let key: unknown;
  try {
    namespace = address?.namespace;
    key = address?.key;
  } catch {
    throw new TypeError("Persistent memory address must be readable.");
  }
  if (typeof namespace !== "string" || !namespace ||
      typeof key !== "string" || !key) {
    throw new TypeError("Persistent memory address is invalid.");
  }
  return Object.freeze({ namespace, key });
}

function tenantFromScopedNamespace(namespace: string): string {
  const separator = namespace.indexOf("/");
  if (separator <= 0 || separator === namespace.length - 1) {
    throw new TypeError("Persistent memory namespace must include a tenant scope prefix.");
  }
  try {
    const encodedTenant = namespace.slice(0, separator);
    const tenantId = decodeURIComponent(encodedTenant);
    const hasControlCharacter = Array.from(tenantId).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    });
    if (!tenantId || tenantId.length > 128 || tenantId.trim().length === 0 ||
        hasControlCharacter || encodeURIComponent(tenantId) !== encodedTenant) throw new Error("invalid");
    return tenantId;
  } catch {
    throw new TypeError("Persistent memory namespace has an invalid tenant scope prefix.");
  }
}


/** The exact same canonical identity is supplied on writes, reads, and key rotation. */
function encryptionContext(address: MemoryAddress, tenantId: string): MemoryEncryptionContext {
  return Object.freeze({ tenantId, namespace: target.namespace, key: target.key });
}
