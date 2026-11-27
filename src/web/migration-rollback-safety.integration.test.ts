import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresPool } from "../persistence/postgres-pool.js";

const databaseUrl = process.env.INFINYX_TEST_DATABASE_URL;
const integrationDescribe = databaseUrl ? describe : describe.skip;
const require = createRequire(import.meta.url);

type MigrationModule = {
  down: (pgm: { sql: (statement: string) => void }) => void;
};

function captureDownSql(file: string): string {
  const migration = require(`../../migrations/${file}`) as MigrationModule;
  const statements: string[] = [];
  migration.down({ sql: statement => statements.push(statement) });
  if (statements.length === 0) throw new Error(`Migration ${file} has no down SQL.`);
  return statements.join("\n");
}

integrationDescribe("database migration rollback safety", () => {
  let adminPool: ReturnType<typeof createPostgresPool>;

  beforeAll(() => {
    adminPool = createPostgresPool({
      DATABASE_URL: process.env.DATABASE_URL!,
      DATABASE_SSL: "disable",
      DATABASE_POOL_MAX: "3",
      DATABASE_CONNECTION_TIMEOUT_MS: "5000",
      DATABASE_IDLE_TIMEOUT_MS: "1000",
      DATABASE_STATEMENT_TIMEOUT_MS: "5000"
    });
  });

  afterAll(async () => {
    if (adminPool) await adminPool.end();
  });

  it("refuses to roll back account security, recovery audit, or revocation history", async () => {
    const userId = randomUUID();
    const issuer = `https://rollback-${randomUUID()}.example.test`;
    const subject = `rollback-subject-${randomUUID()}`;
    const correlationId = randomUUID();
    await adminPool.query("INSERT INTO users (id) VALUES ($1::uuid)", [userId]);
    const identity = await adminPool.query<{ identity_id: string }>(
      `INSERT INTO user_external_identities (user_id, issuer, subject)
       VALUES ($1::uuid, $2, $3)
       RETURNING identity_id::text AS identity_id`,
      [userId, issuer, subject]
    );
    await adminPool.query(
      `UPDATE user_account_security
          SET status = 'suspended', version = version + 1,
              updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond'),
              status_changed_by = $2::uuid,
              status_change_reason = 'rollback_safety_test',
              status_change_correlation_id = $3::uuid
        WHERE user_id = $1::uuid`,
      [userId, userId, correlationId]
    );
    await adminPool.query(
      `INSERT INTO user_account_recovery_audit_events
         (user_id, identity_id, outcome, reason_code, correlation_id)
       VALUES ($1::uuid, $2::uuid, 'denied', 'rollback_safety_test', $3::uuid)`,
      [userId, identity.rows[0]!.identity_id, randomUUID()]
    );

    const rollbackFiles = [
      "012_user_account_security_lifecycle.cjs",
      "013_account_session_revocation_outbox.cjs",
      "014_account_recovery_workflow.cjs",
      "015_database_owned_session_revocation_completion.cjs"
    ];
    for (const file of rollbackFiles) {
      const sql = captureDownSql(file);
      await expect(adminPool.query(sql), file).rejects.toThrow(/Refusing to/iu);
    }

    const stillPresent = await adminPool.query(
      `SELECT
         to_regclass('public.user_account_security') IS NOT NULL AS account_state,
         to_regclass('public.user_account_session_revocation_outbox') IS NOT NULL AS account_outbox,
         to_regclass('public.user_account_recovery_audit_events') IS NOT NULL AS recovery_audit`
    );
    expect(stillPresent.rows[0]).toEqual({
      account_state: true, account_outbox: true, recovery_audit: true
    });
  });

  it("refuses to remove a durable refresh reservation while its outcome is active or ambiguous", async () => {
    const sessionHash = randomBytes(32);
    try {
      await adminPool.query(
        `INSERT INTO web_sessions
           (session_id_hash, user_id, issuer, subject, csrf_token_hash,
            encrypted_token_bundle, idle_expires_at, absolute_expires_at, refresh_attempt_id)
         VALUES ($1, '10000000-0000-4000-8000-000000000001'::uuid,
                 'https://rollback-refresh.example.test', $2, $3, $4,
                 clock_timestamp() + interval '30 minutes',
                 clock_timestamp() + interval '8 hours', $5::uuid)`,
        [sessionHash, `subject-${randomUUID()}`, randomBytes(32), randomBytes(64), randomUUID()]
      );

      const rollbackSql = captureDownSql("016_durable_session_refresh_reservation.cjs");
      await expect(adminPool.query(rollbackSql))
        .rejects.toThrow(/Refusing to remove web-session refresh reservations/iu);

      const stillPresent = await adminPool.query<{ refresh_attempt_id: string | null }>(
        "SELECT refresh_attempt_id::text FROM web_sessions WHERE session_id_hash = $1",
        [sessionHash]
      );
      expect(stillPresent.rows).toHaveLength(1);
      expect(stillPresent.rows[0]?.refresh_attempt_id).toMatch(/^[0-9a-f-]{36}$/iu);
    } finally {
      await adminPool.query("DELETE FROM web_sessions WHERE session_id_hash = $1", [sessionHash]);
    }
  });
});
