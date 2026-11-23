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
    this.#table = options.tableName ?? "infinyx_memory.memory_entries";
    this.#retentionDays = options.retentionDays ?? 90;
    this.#now = options.now ?? (() => new Date());
    if (!Number.isSafeInteger(this.#retentionDays) || this.#retentionDays < 1 || this.#retentionDays > 3650) {
      throw new TypeError("retentionDays must be an integer between 1 and 3650.");
    }
  }

  async read(address: MemoryAddress): Promise<unknown | null> {
    const tenantId = tenantFromScopedNamespace(address.namespace);
    const result = await this.db.query<{ envelope: StoredMemoryEnvelope; expires_at: Date | string }>(
      `SELECT envelope, expires_at FROM ${this.#table}
       WHERE tenant_id = $1 AND namespace = $2 AND memory_key = $3 LIMIT 1`,
      [tenantId, address.namespace, address.key]
    );
    const row = result.rows[0];
    if (!row) return null;
    if (new Date(row.expires_at).getTime() <= this.#now().getTime()) {
      await this.delete(address);
      return null;
    }
    return this.cipher.decrypt(row.envelope, encryptionContext(address, tenantId));
  }

  async write(address: MemoryAddress, value: unknown): Promise<void> {
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
    const tenantId = tenantFromScopedNamespace(address.namespace);
    const encrypted = await this.cipher.encrypt(value, encryptionContext(address, tenantId));
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
         envelope = EXCLUDED.envelope, classification = EXCLUDED.classification, updated_at = EXCLUDED.updated_at, expires_at = EXCLUDED.expires_at`,
      [tenantId, address.namespace, address.key, JSON.stringify(envelope), classification, now, expiresAt]
    );
  }

  async delete(address: MemoryAddress): Promise<void> {
    const tenantId = tenantFromScopedNamespace(address.namespace);
    await this.db.query(`DELETE FROM ${this.#table} WHERE tenant_id = $1 AND namespace = $2 AND memory_key = $3`, [
      tenantId, address.namespace, address.key
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
    for (const row of selected.rows) {
      const context = encryptionContext({ namespace: row.namespace, key: row.memory_key }, row.tenant_id);
      const replacement = await this.cipher.reencrypt(row.envelope, context);
      const result = await this.db.query(
        `UPDATE ${this.#table}
         SET envelope = $1::jsonb, updated_at = $2
         WHERE tenant_id = $3 AND namespace = $4 AND memory_key = $5 AND envelope = $6::jsonb`,
        [JSON.stringify({ ...replacement, schemaVersion: row.envelope.schemaVersion,
          createdAt: row.envelope.createdAt, updatedAt: this.#now().toISOString(),
          expiresAt: row.envelope.expiresAt, classification: row.envelope.classification }),
          this.#now(), row.tenant_id, row.namespace, row.memory_key, JSON.stringify(row.envelope)]
      );
      if ((result.rowCount ?? 0) === 1) rotated += 1;
    }
    return { examined: selected.rows.length, rotated };
  }

  /** Bounded expiry sweep; call from a controlled maintenance job, never module code. */
  async deleteExpired(batchSize = 500): Promise<number> {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
      throw new TypeError("batchSize must be between 1 and 10000.");
    }
    const result = await this.db.query(
      `WITH expired AS (
         SELECT tenant_id, namespace, memory_key FROM ${this.#table}
         WHERE expires_at <= now()
         ORDER BY expires_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       DELETE FROM ${this.#table} AS target
       USING expired
       WHERE target.tenant_id = expired.tenant_id
         AND target.namespace = expired.namespace AND target.memory_key = expired.memory_key`,
      [batchSize]
    );
    return result.rowCount ?? 0;
  }
}


/**
 * GuardedMemoryPort encodes the authenticated tenant as the first namespace
 * segment. Persist it separately so every point query is tenant-qualified.
 * This is defense in depth, not authentication: the composition root must still
 * derive the namespace from a trusted principal.
 */
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
  return Object.freeze({ tenantId, namespace: address.namespace, key: address.key });
}
