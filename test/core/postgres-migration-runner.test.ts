import { describe, expect, it } from "vitest";
import {
  PostgresMigrationRunner,
  type MigrationConnection,
  type MigrationPool
} from "../../src/core/postgres-migration-runner.js";

class FakePool implements MigrationPool {
  readonly applied = new Map<string, string>();
  readonly statements: string[] = [];
  failOnSql: string | null = null;
  ledgerInsertRowCount = 1;

  async connect(): Promise<MigrationConnection> {
    const staged = new Map(this.applied);
    return {
      query: async <Row>(sql: string, values: readonly unknown[] = []) => {
        this.statements.push(sql);
        if (sql === "BEGIN" || sql.startsWith("SELECT pg_advisory") ||
            sql.startsWith("CREATE SCHEMA") || sql.startsWith("CREATE TABLE") ||
            sql === "ROLLBACK") return { rows: [] as Row[] };
        if (sql === "COMMIT") {
          this.applied.clear();
          for (const [key, value] of staged) this.applied.set(key, value);
          return { rows: [] as Row[] };
        }
        if (sql.startsWith("SELECT checksum")) {
          const checksum = staged.get(String(values[0]));
          return { rows: (checksum ? [{ checksum }] : []) as Row[] };
        }
        if (sql.startsWith("INSERT INTO infinyx_meta.schema_migrations")) {
          if (this.ledgerInsertRowCount === 1) staged.set(String(values[0]), String(values[1]));
          return { rows: [] as Row[], rowCount: this.ledgerInsertRowCount };
        }
        if (sql === this.failOnSql) throw new Error("migration SQL failed");
        return { rows: [] as Row[], rowCount: 0 };
      },
      release: () => undefined
    };
  }
}

describe("PostgresMigrationRunner", () => {
  it("sorts migrations and records them for resumable repeat runs", async () => {
    const pool = new FakePool();
    const runner = new PostgresMigrationRunner(pool);
    const migrations = [
      { id: "0002_add_index", sql: "CREATE INDEX test_idx ON test_table (id);" },
      { id: "0001_create_table", sql: "CREATE TABLE test_table (id integer);" }
    ];
    await expect(runner.run(migrations)).resolves.toEqual({
      applied: ["0001_create_table", "0002_add_index"],
      skipped: []
    });
    await expect(runner.run(migrations)).resolves.toEqual({
      applied: [],
      skipped: ["0001_create_table", "0002_add_index"]
    });
  });

  it("rejects edits to an already-applied migration", async () => {
    const pool = new FakePool();
    const runner = new PostgresMigrationRunner(pool);
    await runner.run([{ id: "0001_create_table", sql: "CREATE TABLE t (id int);" }]);
    await expect(runner.run([{ id: "0001_create_table", sql: "CREATE TABLE t (id text);" }]))
      .rejects.toThrow("checksum mismatch");
  });

  it("does not record a migration when its SQL fails", async () => {
    const pool = new FakePool();
    pool.failOnSql = "BROKEN SQL";
    const runner = new PostgresMigrationRunner(pool);
    await expect(runner.run([{ id: "0001_broken", sql: "BROKEN SQL" }])).rejects.toThrow("migration SQL failed");
    expect(pool.applied.has("0001_broken")).toBe(false);
    expect(pool.statements).toContain("ROLLBACK");
  });

  it("rolls back the complete batch when a later migration fails", async () => {
    const pool = new FakePool();
    pool.failOnSql = "BROKEN SQL";
    const runner = new PostgresMigrationRunner(pool);
    await expect(runner.run([
      { id: "0001_valid", sql: "CREATE TABLE t (id int);" },
      { id: "0002_broken", sql: "BROKEN SQL" }
    ])).rejects.toThrow("migration SQL failed");
    expect(pool.applied.size).toBe(0);
    expect(pool.statements).toContain("ROLLBACK");
  });

  it("rolls back when the migration ledger insert affects no row", async () => {
    const pool = new FakePool();
    pool.ledgerInsertRowCount = 0;
    const runner = new PostgresMigrationRunner(pool);
    await expect(runner.run([
      { id: "0001_missing_ledger", sql: "CREATE TABLE t (id int);" }
    ])).rejects.toThrow("Migration ledger insert did not affect exactly one row.");
    expect(pool.applied.has("0001_missing_ledger")).toBe(false);
    expect(pool.statements).toContain("ROLLBACK");
    expect(pool.statements).not.toContain("COMMIT");
  });

  it("rejects duplicate and malformed identifiers before opening a connection", async () => {
    const pool = new FakePool();
    const runner = new PostgresMigrationRunner(pool);
    await expect(runner.run([{ id: "bad-id", sql: "SELECT 1" }])).rejects.toThrow(TypeError);
    await expect(runner.run([
      { id: "0001_one", sql: "SELECT 1" },
      { id: "0001_one", sql: "SELECT 2" }
    ])).rejects.toThrow("Duplicate migration identifier");
    expect(pool.statements).toHaveLength(0);
  });
});
