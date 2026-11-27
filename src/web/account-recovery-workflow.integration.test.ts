import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresPool } from "../persistence/postgres-pool.js";
import { recoverSuspendedAccount } from "./account-recovery-workflow.js";
import { createOpaqueSessionId } from "./session-crypto.js";
import { PostgresAccountRecoveryTransactionStore } from "./account-recovery-transactions.js";
import { PostgresWebSessionStore } from "./session-store.js";
import { completeAccountSessionRevocation } from "./account-session-revocation.js";

const databaseUrl = process.env.INFINYX_TEST_DATABASE_URL;
const integrationDescribe = databaseUrl ? describe : describe.skip;

integrationDescribe("PostgreSQL safe suspended account recovery", () => {
  let pool: ReturnType<typeof createPostgresPool>;
  let adminPool: ReturnType<typeof createPostgresPool>;

  beforeAll(() => {
    pool = createPostgresPool({
      DATABASE_URL: databaseUrl!, DATABASE_SSL: "disable",
      DATABASE_POOL_MAX: "8", DATABASE_CONNECTION_TIMEOUT_MS: "5000",
      DATABASE_IDLE_TIMEOUT_MS: "1000", DATABASE_STATEMENT_TIMEOUT_MS: "5000"
    });
    adminPool = createPostgresPool({
      DATABASE_URL: process.env.DATABASE_URL!, DATABASE_SSL: "disable",
      DATABASE_POOL_MAX: "4", DATABASE_CONNECTION_TIMEOUT_MS: "5000",
      DATABASE_IDLE_TIMEOUT_MS: "1000", DATABASE_STATEMENT_TIMEOUT_MS: "5000"
    });
  });

  afterAll(async () => {
    if (pool) await pool.end();
    if (adminPool) await adminPool.end();
  });

  async function createAccount(identityStatus: "active" | "revoked" = "active") {
    const userId = randomUUID();
    const issuer = `https://recovery-${randomUUID()}.example.test`;
    const subject = `subject-${randomUUID()}`;
    const correlationId = randomUUID();
    await adminPool.query("INSERT INTO users (id) VALUES ($1::uuid)", [userId]);
    const inserted = await adminPool.query<{ identity_id: string }>(
      `INSERT INTO user_external_identities (user_id, issuer, subject)
       VALUES ($1::uuid, $2, $3) RETURNING identity_id::text AS identity_id`,
      [userId, issuer, subject]
    );
    const identityId = inserted.rows[0]!.identity_id;

    if (identityStatus === "revoked") {
      await adminPool.query(
        `UPDATE user_external_identity_lifecycle
            SET status = 'revoked', version = version + 1,
                updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond'),
                status_changed_by = $2::uuid,
                status_change_reason = 'test_revoked',
                status_change_correlation_id = $3::uuid
          WHERE identity_id = $1::uuid`,
        [identityId, userId, randomUUID()]
      );
    }

    await adminPool.query(
      `UPDATE user_account_security
          SET status = 'suspended', version = version + 1,
              updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond'),
              status_changed_by = $2::uuid,
              status_change_reason = 'test_suspend',
              status_change_correlation_id = $3::uuid
        WHERE user_id = $1::uuid`,
      [userId, userId, correlationId]
    );
    await adminPool.query(
      `UPDATE user_account_session_revocation_outbox
          SET completed_at = now(), attempts = attempts + 1
        WHERE user_id = $1::uuid AND completed_at IS NULL`,
      [userId]
    );
    return { userId, issuer, subject, identityId };
  }

  it("persists and consumes recovery transactions with the least-privilege application role", async () => {
    const store = new PostgresAccountRecoveryTransactionStore(pool, Buffer.alloc(32, 23));
    const state = createOpaqueSessionId();
    const browserBinding = createOpaqueSessionId();
    const payload = { codeVerifier: "A".repeat(64), nonce: createOpaqueSessionId() };
    await store.create(state, browserBinding, payload, new Date(Date.now() + 240_000));
    await expect(store.consume(state, createOpaqueSessionId())).resolves.toBeNull();
    await expect(store.consume(state, browserBinding)).resolves.toMatchObject({ payload });
    await expect(store.consume(state, browserBinding)).resolves.toBeNull();
  });

  it("recovers only through the exact active identity and preserves identity binding and lifecycle history", async () => {
    const account = await createAccount();
    const bindingBefore = await adminPool.query(
      `SELECT identity_id::text, user_id::text, issuer, subject, created_at
         FROM user_external_identities WHERE identity_id = $1::uuid`,
      [account.identityId]
    );
    const lifecycleBefore = await adminPool.query(
      `SELECT event_id::text, from_status, to_status, actor_user_id::text,
              reason_code, correlation_id::text, created_at
         FROM user_external_identity_lifecycle_events
        WHERE identity_id = $1::uuid ORDER BY created_at, event_id`,
      [account.identityId]
    );

    const recoveryCorrelationId = randomUUID();
    const result = await recoverSuspendedAccount(
      pool, account.issuer, account.subject, recoveryCorrelationId
    );
    expect(result.outcome).toBe("recovered");
    if (result.outcome !== "recovered") throw new Error("Expected recovered outcome.");

    const state = await adminPool.query(
      "SELECT status, version, status_change_reason FROM user_account_security WHERE user_id = $1::uuid",
      [account.userId]
    );
    expect(state.rows[0]).toMatchObject({
      status: "active", version: 3, status_change_reason: "account_recovered"
    });

    const outbox = await adminPool.query(
      `SELECT user_id::text, completed_at
         FROM user_account_session_revocation_outbox WHERE outbox_id = $1::uuid`,
      [result.outboxId]
    );
    expect(outbox.rows[0]).toEqual({ user_id: account.userId, completed_at: null });

    const sessions = new PostgresWebSessionStore(pool, Buffer.alloc(32, 31));
    await expect(completeAccountSessionRevocation(
      pool, sessions, account.userId, result.outboxId
    )).resolves.toBe(true);
    const completedOutbox = await adminPool.query(
      "SELECT completed_at FROM user_account_session_revocation_outbox WHERE outbox_id = $1::uuid",
      [result.outboxId]
    );
    expect(completedOutbox.rows[0]?.completed_at).not.toBeNull();

    const audit = await adminPool.query(
      `SELECT outcome, reason_code, user_id::text, identity_id::text
         FROM user_account_recovery_audit_events
        WHERE correlation_id = $1::uuid`,
      [recoveryCorrelationId]
    );
    expect(audit.rows[0]).toMatchObject({
      outcome: "succeeded", reason_code: "active_identity_proved",
      user_id: account.userId, identity_id: account.identityId
    });

    const bindingAfter = await adminPool.query(
      `SELECT identity_id::text, user_id::text, issuer, subject, created_at
         FROM user_external_identities WHERE identity_id = $1::uuid`,
      [account.identityId]
    );
    expect(bindingAfter.rows).toEqual(bindingBefore.rows);
    const lifecycleAfter = await adminPool.query(
      `SELECT event_id::text, from_status, to_status, actor_user_id::text,
              reason_code, correlation_id::text, created_at
         FROM user_external_identity_lifecycle_events
        WHERE identity_id = $1::uuid ORDER BY created_at, event_id`,
      [account.identityId]
    );
    expect(lifecycleAfter.rows).toEqual(lifecycleBefore.rows);
  });

  it("cannot recover an account through a revoked identity", async () => {
    const account = await createAccount("revoked");
    const result = await recoverSuspendedAccount(
      pool, account.issuer, account.subject, randomUUID()
    );
    expect(result).toEqual({ outcome: "denied" });
    const state = await adminPool.query(
      "SELECT status, version FROM user_account_security WHERE user_id = $1::uuid",
      [account.userId]
    );
    expect(state.rows[0]).toEqual({ status: "suspended", version: 2 });
    const lifecycle = await adminPool.query(
      "SELECT status, version FROM user_external_identity_lifecycle WHERE identity_id = $1::uuid",
      [account.identityId]
    );
    expect(lifecycle.rows[0]).toEqual({ status: "revoked", version: 2 });
  });

  it("cannot recover a disabled account", async () => {
    const account = await createAccount();
    await adminPool.query(
      `UPDATE user_account_security
          SET status = 'disabled', version = version + 1,
              updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond'),
              status_changed_by = $2::uuid,
              status_change_reason = 'test_disable',
              status_change_correlation_id = $3::uuid
        WHERE user_id = $1::uuid`,
      [account.userId, account.userId, randomUUID()]
    );
    await adminPool.query(
      `UPDATE user_account_session_revocation_outbox
          SET completed_at = now(), attempts = attempts + 1
        WHERE user_id = $1::uuid AND completed_at IS NULL`,
      [account.userId]
    );

    const result = await recoverSuspendedAccount(
      pool, account.issuer, account.subject, randomUUID()
    );
    expect(result).toEqual({ outcome: "denied" });
    const state = await adminPool.query(
      "SELECT status, version FROM user_account_security WHERE user_id = $1::uuid",
      [account.userId]
    );
    expect(state.rows[0]).toEqual({ status: "disabled", version: 3 });
  });

  it("serializes concurrent recovery attempts so only one transition succeeds", async () => {
    const account = await createAccount();
    const [first, second] = await Promise.all([
      recoverSuspendedAccount(pool, account.issuer, account.subject, randomUUID()),
      recoverSuspendedAccount(pool, account.issuer, account.subject, randomUUID())
    ]);
    expect([first, second].filter(x => x.outcome === "recovered")).toHaveLength(1);
    expect([first, second].filter(x => x.outcome === "denied")).toHaveLength(1);
    const state = await adminPool.query(
      "SELECT status, version FROM user_account_security WHERE user_id = $1::uuid",
      [account.userId]
    );
    expect(state.rows[0]).toEqual({ status: "active", version: 3 });
  });

  it("does not recover by email, phone, or an unbound identity", async () => {
    const account = await createAccount();
    const result = await recoverSuspendedAccount(
      pool, account.issuer, `not-bound-${randomUUID()}`, randomUUID()
    );
    expect(result).toEqual({ outcome: "denied" });
    const state = await adminPool.query(
      "SELECT status FROM user_account_security WHERE user_id = $1::uuid",
      [account.userId]
    );
    expect(state.rows[0]?.status).toBe("suspended");
  });
});
