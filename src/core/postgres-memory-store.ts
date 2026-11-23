import type { MemoryAddress, MemoryPort } from "./contracts.js";
import { MemoryValueCipher, type EncryptedMemoryEnvelope } from "./memory-encryption.js";

export interface SqlQueryResult<Row> {
  readonly rows: readonly Row[];
  readonly rowCount?: number | null;
}

/** Structural subset implemented by pg.Pool and pg.Client; no driver is coupled to Core. */
export interface SqlExecutor {
  query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<SqlQueryResult<Row>>;
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
    const result = await this.db.query<{ envelope: EncryptedMemoryEnvelope; expires_at: Date | string }>(
      `SELECT envelope, expires_at FROM ${this.#table} WHERE namespace = $1 AND memory_key = $2 LIMIT 1`,
      [address.namespace, address.key]
    );
    const row = result.rows[0];
    if (!row) return null;
    if (new Date(row.expires_at).getTime() <= this.#now().getTime()) {
      await this.delete(address);
      return null;
    }
    return this.cipher.decrypt(row.envelope);
  }

  async write(address: MemoryAddress, value: unknown): Promise<void> {
    if (typeof value !== "string") throw new TypeError("GuardedMemoryPort must provide serialized JSON strings.");
    const envelope = await this.cipher.encrypt(value);
    await this.db.query(
      `INSERT INTO ${this.#table} (namespace, memory_key, envelope, created_at, updated_at, expires_at)
       VALUES ($1, $2, $3::jsonb, now(), now(), now() + ($4::text || ' days')::interval)
       ON CONFLICT (namespace, memory_key) DO UPDATE SET
         envelope = EXCLUDED.envelope, updated_at = now(), expires_at = EXCLUDED.expires_at`,
      [address.namespace, address.key, JSON.stringify(envelope), this.#retentionDays]
    );
  }

  async delete(address: MemoryAddress): Promise<void> {
    await this.db.query(`DELETE FROM ${this.#table} WHERE namespace = $1 AND memory_key = $2`, [
      address.namespace, address.key
    ]);
  }

  /** Bounded expiry sweep; call from a controlled maintenance job, never module code. */
  async deleteExpired(batchSize = 500): Promise<number> {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
      throw new TypeError("batchSize must be between 1 and 10000.");
    }
    const result = await this.db.query(
      `WITH expired AS (
         SELECT namespace, memory_key FROM ${this.#table}
         WHERE expires_at <= now()
         ORDER BY expires_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       DELETE FROM ${this.#table} AS target
       USING expired
       WHERE target.namespace = expired.namespace AND target.memory_key = expired.memory_key`,
      [batchSize]
    );
    return result.rowCount ?? 0;
  }
}
