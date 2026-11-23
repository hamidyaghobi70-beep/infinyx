import { createHash } from "node:crypto";

export interface CoreMigration {
  /** Stable, sortable identifier, e.g. 0002_add_memory_metadata. */
  readonly id: string;
  /** Complete SQL body. The complete ordered migration batch is atomic. */
  readonly sql: string;
}

export interface MigrationQueryResult<Row> {
  readonly rows: readonly Row[];
  readonly rowCount?: number | null;
}

export interface MigrationConnection {
  query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<MigrationQueryResult<Row>>;
  release(): void;
}

export interface MigrationPool {
  connect(): Promise<MigrationConnection>;
}

export interface MigrationRunResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

/**
 * Idempotent, resumable PostgreSQL migration runner.
 *
 * The ordered batch and all ledger records commit in one transaction. A
 * transaction-scoped advisory lock spans the entire batch, preventing different
 * application versions from interleaving migration sequences. A changed SQL body
 * for an already-applied identifier is rejected.
 */
export class PostgresMigrationRunner {
  constructor(private readonly pool: MigrationPool) {}

  async run(migrations: readonly CoreMigration[]): Promise<MigrationRunResult> {
    const ordered = [...migrations].sort((a, b) => a.id.localeCompare(b.id));
    const seen = new Set<string>();
    for (const migration of ordered) {
      if (!/^[0-9]{4}_[a-z0-9_]+$/.test(migration.id)) {
        throw new TypeError("Migration identifiers must match NNNN_lowercase_name.");
      }
      if (seen.has(migration.id)) throw new TypeError(`Duplicate migration identifier: ${migration.id}`);
      if (typeof migration.sql !== "string" || migration.sql.trim().length === 0) {
        throw new TypeError(`Migration ${migration.id} has an empty SQL body.`);
      }
      seen.add(migration.id);
    }
    if (ordered.length === 0) return Object.freeze({ applied: [], skipped: [] });

    const applied: string[] = [];
    const skipped: string[] = [];
    const connection = await this.pool.connect();
    try {
      await connection.query("BEGIN");
      await connection.query("SELECT pg_advisory_xact_lock($1)", [7_314_209_041]);
      await connection.query("CREATE SCHEMA IF NOT EXISTS infinyx_meta");
      await connection.query(`CREATE TABLE IF NOT EXISTS infinyx_meta.schema_migrations (
        migration_id text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

      for (const migration of ordered) {
        const checksum = createHash("sha256").update(migration.sql, "utf8").digest("hex");
        const existing = await connection.query<{ checksum: string }>(
          "SELECT checksum FROM infinyx_meta.schema_migrations WHERE migration_id = $1 FOR UPDATE",
          [migration.id]
        );
        const recorded = existing.rows[0]?.checksum;
        if (recorded !== undefined) {
          if (recorded !== checksum) {
            throw new Error(`Applied migration ${migration.id} checksum mismatch; refusing to continue.`);
          }
          skipped.push(migration.id);
          continue;
        }

        // SQL and ledger insertion share the batch transaction. A failed migration
        // rolls back every schema change and ledger row from this invocation.
        await connection.query(migration.sql);
        await connection.query(
          "INSERT INTO infinyx_meta.schema_migrations (migration_id, checksum) VALUES ($1, $2)",
          [migration.id, checksum]
        );
        applied.push(migration.id);
      }
      await connection.query("COMMIT");
    } catch (error) {
      try { await connection.query("ROLLBACK"); } catch { /* preserve original failure */ }
      throw error;
    } finally {
      connection.release();
    }
    return Object.freeze({ applied: Object.freeze(applied), skipped: Object.freeze(skipped) });
  }
}
