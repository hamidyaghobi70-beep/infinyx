import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { PostgresMigrationRunner } from "../dist/core/postgres-migration-runner.js";

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for PostgreSQL integration tests.");

const pool = new Pool({ connectionString, max: 4 });
const migrationPool = {
  async connect() {
    const client = await pool.connect();
    return {
      async query(sql, values = []) {
        const result = await client.query(sql, values);
        return { rows: result.rows, rowCount: result.rowCount };
      },
      release() {
        client.release();
      }
    };
  }
};

try {
  const migrations = await Promise.all([
    "0001_stage4_memory_audit.sql",
    "0002_stage4_least_privilege_roles.sql"
  ].map(async (name, index) => ({
    id: name.slice(0, 4) + "_" + name.slice(5, -4),
    sql: await readFile(resolve("migrations", name), "utf8")
  })));

  const runner = new PostgresMigrationRunner(migrationPool);
  const first = await runner.run(migrations);
  assert.deepEqual(first.applied, ["0001_stage4_memory_audit", "0002_stage4_least_privilege_roles"]);
  assert.deepEqual(first.skipped, []);

  const second = await runner.run(migrations);
  assert.deepEqual(second.applied, []);
  assert.deepEqual(second.skipped, ["0001_stage4_memory_audit", "0002_stage4_least_privilege_roles"]);

  const schema = await pool.query(`
    SELECT
      to_regclass('infinyx_memory.memory_entries') IS NOT NULL AS memory_table,
      to_regclass('infinyx_audit.memory_access_events') IS NOT NULL AS audit_table,
      EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'infinyx_memory_runtime') AS memory_role,
      EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'infinyx_audit_writer') AS audit_writer_role,
      has_table_privilege('infinyx_memory_runtime', 'infinyx_memory.memory_entries', 'SELECT') AS memory_select,
      has_table_privilege('infinyx_audit_writer', 'infinyx_audit.memory_access_events', 'INSERT') AS audit_insert,
      has_table_privilege('infinyx_audit_writer', 'infinyx_audit.memory_access_events', 'UPDATE') AS audit_update,
      has_table_privilege('infinyx_audit_writer', 'infinyx_audit.memory_access_events', 'DELETE') AS audit_delete
  `);
  assert.deepEqual(schema.rows[0], {
    memory_table: true,
    audit_table: true,
    memory_role: true,
    audit_writer_role: true,
    memory_select: true,
    audit_insert: true,
    audit_update: false,
    audit_delete: false
  });

  await assert.rejects(
    runner.run([
      { id: "9001_integration_rollback_probe", sql: "CREATE TABLE public.infinyx_rollback_probe (id integer PRIMARY KEY);" },
      { id: "9002_integration_force_failure", sql: "THIS IS INTENTIONALLY INVALID SQL;" }
    ]),
    /syntax error/i
  );
  const rollback = await pool.query("SELECT to_regclass('public.infinyx_rollback_probe') AS probe");
  assert.equal(rollback.rows[0].probe, null, "failed migration batch must roll back prior DDL");

  console.log("PostgreSQL integration checks passed: migrations, idempotency, least-privilege grants, and atomic rollback.");
} finally {
  await pool.end();
}
