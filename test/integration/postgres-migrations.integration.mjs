import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { PostgresMigrationRunner } from "../../dist/core/postgres-migration-runner.js";

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
  ].map(async (name) => ({
    id: name.slice(0, 4) + "_" + name.slice(5, -4),
    sql: await readFile(resolve("migrations", name), "utf8")
  })));

  const runner = new PostgresMigrationRunner(migrationPool);

  // Existing LOGIN roles and transitive inherited role memberships must fail closed.
  await pool.query("CREATE ROLE infinyx_memory_runtime LOGIN");
  await pool.query("CREATE ROLE infinyx_test_privileged_group NOLOGIN");
  await pool.query("CREATE ROLE infinyx_test_intermediate_group NOLOGIN");
  await pool.query("CREATE ROLE infinyx_audit_writer NOLOGIN");
  await pool.query("GRANT infinyx_test_privileged_group TO infinyx_test_intermediate_group");
  await pool.query("GRANT infinyx_test_intermediate_group TO infinyx_audit_writer");
  await assert.rejects(
    runner.run(migrations),
    /Stage 4 roles have unsafe attributes or memberships; refusing grants: infinyx_audit_writer, infinyx_memory_runtime/
  );
  const failedPreflight = await pool.query(`
    SELECT
      to_regclass('infinyx_memory.memory_entries') AS memory_table,
      to_regclass('infinyx_meta.schema_migrations') AS migration_ledger
  `);
  assert.equal(failedPreflight.rows[0].memory_table, null, "unsafe pre-existing role must roll back schema creation");
  assert.equal(failedPreflight.rows[0].migration_ledger, null, "unsafe pre-existing role must roll back migration ledger creation");
  await pool.query("REVOKE infinyx_test_intermediate_group FROM infinyx_audit_writer");
  await pool.query("REVOKE infinyx_test_privileged_group FROM infinyx_test_intermediate_group");
  await pool.query("DROP ROLE infinyx_audit_writer");
  await pool.query("DROP ROLE infinyx_test_intermediate_group");
  await pool.query("DROP ROLE infinyx_test_privileged_group");
  await pool.query("DROP ROLE infinyx_memory_runtime");

  // Object ownership is an implicit privilege; REVOKE cannot neutralize it.
  // A pre-existing schema owned by a service role must block the migration.
  await pool.query("CREATE ROLE infinyx_memory_runtime NOLOGIN");
  await pool.query("CREATE SCHEMA infinyx_memory AUTHORIZATION infinyx_memory_runtime");
  await assert.rejects(
    runner.run(migrations),
    /Stage 4 roles have unsafe attributes or memberships; refusing grants: infinyx_memory_runtime/
  );
  const ownershipPreflight = await pool.query(`
    SELECT
      to_regclass('infinyx_memory.memory_entries') AS memory_table,
      to_regclass('infinyx_meta.schema_migrations') AS migration_ledger,
      (SELECT r.rolname
       FROM pg_namespace AS n
       JOIN pg_roles AS r ON r.oid = n.nspowner
       WHERE n.nspname = 'infinyx_memory') AS schema_owner
  `);
  assert.equal(ownershipPreflight.rows[0].memory_table, null, "owned pre-existing schema must block memory table creation");
  assert.equal(ownershipPreflight.rows[0].migration_ledger, null, "owned pre-existing schema must roll back migration ledger creation");
  assert.equal(ownershipPreflight.rows[0].schema_owner, "infinyx_memory_runtime", "failed preflight must not silently transfer schema ownership");
  await pool.query("DROP SCHEMA infinyx_memory CASCADE");
  await pool.query("DROP ROLE infinyx_memory_runtime");

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
      EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'infinyx_audit_reader') AS audit_reader_role,
      (SELECT bool_and(NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls)
       FROM pg_roles WHERE rolname IN ('infinyx_memory_runtime', 'infinyx_audit_writer', 'infinyx_audit_reader')) AS stage4_roles_are_restricted,
      has_schema_privilege('infinyx_memory_runtime', 'infinyx_memory', 'USAGE') AS memory_schema_usage,
      has_schema_privilege('infinyx_memory_runtime', 'infinyx_memory', 'CREATE') AS memory_schema_create,
      has_schema_privilege('infinyx_audit_writer', 'infinyx_audit', 'CREATE') AS audit_writer_schema_create,
      has_table_privilege('infinyx_memory_runtime', 'infinyx_memory.memory_entries', 'SELECT') AS memory_select,
      has_table_privilege('infinyx_audit_writer', 'infinyx_audit.memory_access_events', 'INSERT') AS audit_insert,
      has_table_privilege('infinyx_audit_writer', 'infinyx_audit.memory_access_events', 'SELECT') AS audit_writer_select,
      has_table_privilege('infinyx_audit_writer', 'infinyx_audit.memory_access_events', 'UPDATE') AS audit_update,
      has_table_privilege('infinyx_audit_writer', 'infinyx_audit.memory_access_events', 'DELETE') AS audit_delete,
      has_table_privilege('infinyx_audit_reader', 'infinyx_audit.memory_access_events', 'SELECT') AS audit_reader_select,
      has_table_privilege('infinyx_audit_reader', 'infinyx_audit.memory_access_events', 'INSERT') AS audit_reader_insert,
      has_table_privilege('infinyx_audit_reader', 'infinyx_audit.memory_access_events', 'UPDATE') AS audit_reader_update,
      has_table_privilege('infinyx_audit_reader', 'infinyx_audit.memory_access_events', 'DELETE') AS audit_reader_delete,
      has_table_privilege('infinyx_audit_writer', 'infinyx_audit.audit_chain_state', 'SELECT') AS chain_state_select,
      has_table_privilege('infinyx_audit_writer', 'infinyx_audit.audit_chain_state', 'UPDATE') AS chain_state_update,
      has_table_privilege('infinyx_audit_writer', 'infinyx_audit.audit_chain_state', 'INSERT') AS chain_state_insert,
      has_table_privilege('infinyx_audit_writer', 'infinyx_audit.audit_chain_state', 'DELETE') AS chain_state_delete
  `);
  assert.deepEqual(schema.rows[0], {
    memory_table: true,
    audit_table: true,
    memory_role: true,
    audit_writer_role: true,
    audit_reader_role: true,
    stage4_roles_are_restricted: true,
    memory_schema_usage: true,
    memory_schema_create: false,
    audit_writer_schema_create: false,
    memory_select: true,
    audit_insert: true,
    audit_writer_select: false,
    audit_update: false,
    audit_delete: false,
    audit_reader_select: true,
    audit_reader_insert: false,
    audit_reader_update: false,
    audit_reader_delete: false,
    chain_state_select: true,
    chain_state_update: true,
    chain_state_insert: false,
    chain_state_delete: false
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

  // A ledger-write failure after migration DDL must also roll back that DDL.
  await pool.query(`
    CREATE FUNCTION public.infinyx_reject_test_ledger_insert()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $infinyx$
    BEGIN
      IF NEW.migration_id = '9003_integration_ledger_failure' THEN
        RAISE EXCEPTION 'forced migration ledger insert failure';
      END IF;
      RETURN NEW;
    END;
    $infinyx$
  `);
  await pool.query(`
    CREATE TRIGGER infinyx_reject_test_ledger_insert
    BEFORE INSERT ON infinyx_meta.schema_migrations
    FOR EACH ROW
    EXECUTE FUNCTION public.infinyx_reject_test_ledger_insert()
  `);
  try {
    await assert.rejects(
      runner.run([{
        id: "9003_integration_ledger_failure",
        sql: "CREATE TABLE public.infinyx_ledger_failure_probe (id integer PRIMARY KEY);"
      }]),
      /forced migration ledger insert failure/
    );
    const ledgerFailureRollback = await pool.query(`
      SELECT
        to_regclass('public.infinyx_ledger_failure_probe') AS probe,
        EXISTS (
          SELECT 1 FROM infinyx_meta.schema_migrations
          WHERE migration_id = '9003_integration_ledger_failure'
        ) AS ledger_row
    `);
    assert.equal(ledgerFailureRollback.rows[0].probe, null, "ledger insert failure must roll back migration DDL");
    assert.equal(ledgerFailureRollback.rows[0].ledger_row, false, "failed ledger insert must leave no migration record");
  } finally {
    await pool.query("DROP TRIGGER infinyx_reject_test_ledger_insert ON infinyx_meta.schema_migrations");
    await pool.query("DROP FUNCTION public.infinyx_reject_test_ledger_insert()");
  }

  console.log("PostgreSQL integration checks passed: migrations, idempotency, least-privilege grants, and atomic rollback.");
} finally {
  await pool.end();
}
