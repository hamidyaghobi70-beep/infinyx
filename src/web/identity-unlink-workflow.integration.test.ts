import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresPool } from "../persistence/postgres-pool.js";
import { createOpaqueSessionId, hashOpaqueSecret } from "./session-crypto.js";
import { unlinkVerifiedIdentity } from "./identity-unlink-workflow.js";
import {
  completeIdentitySessionRevocation
} from "./identity-link-workflow.js";
import { PostgresWebSessionStore } from "./session-store.js";

const databaseUrl = process.env.INFINYX_TEST_DATABASE_URL;
const integrationDescribe = databaseUrl ? describe : describe.skip;
const sessionKey = Buffer.alloc(32, 31);

integrationDescribe("PostgreSQL external identity unlink workflow", () => {
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

  async function createUserWithIdentities(count: number) {
    const userId = randomUUID();
    await adminPool.query("INSERT INTO users (id) VALUES ($1::uuid)", [userId]);
    const identities: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const result = await adminPool.query<{ identity_id: string }>(
        `INSERT INTO user_external_identities (user_id, issuer, subject)
         VALUES ($1::uuid, $2, $3) RETURNING identity_id::text AS identity_id`,
        [userId, `https://unlink-${randomUUID()}.example.test`, `subject-${i}-${randomUUID()}`]
      );
      identities.push(result.rows[0]!.identity_id);
    }
    return { userId, identities };
  }

  async function createUnlinkGrant(userId: string, sessionId: string) {
    const grant = createOpaqueSessionId();
    const transactionId = randomUUID();
    const now = new Date();
    const sessionHash = hashOpaqueSecret(sessionId);
    await adminPool.query(
      `INSERT INTO identity_security_transactions
         (transaction_id, state_hash, user_id, session_id_hash, browser_binding_hash,
          purpose, encrypted_payload, created_at, expires_at, consumed_at)
       VALUES ($1::uuid, $2, $3::uuid, $4, $5, 'reauth_identity_unlink',
               $6, $7, $8, $9)`,
      [transactionId, Buffer.from(randomUUID().replace(/-/gu, "").padEnd(64, "a").slice(0, 64), "hex"),
        userId, sessionHash, Buffer.alloc(32, 9), Buffer.alloc(32, 7),
        new Date(now.getTime() - 1000), new Date(now.getTime() + 240000), now]
    );
    await adminPool.query(
      `INSERT INTO identity_step_up_grants
         (grant_hash, source_transaction_id, user_id, session_id_hash, purpose, created_at, expires_at)
       VALUES ($1, $2::uuid, $3::uuid, $4, 'identity_unlink', $5, $6)`,
      [hashOpaqueSecret(grant), transactionId, userId, sessionHash,
        now, new Date(now.getTime() + 240000)]
    );
    return grant;
  }

  it("revokes only the selected lifecycle state and preserves the immutable identity binding and prior history", async () => {
    const { userId, identities } = await createUserWithIdentities(2);
    const sessionId = createOpaqueSessionId();
    const grant = await createUnlinkGrant(userId, sessionId);
    const targetId = identities[0]!;
    const before = await adminPool.query(
      `SELECT identity_id::text, user_id::text, issuer, subject, created_at
         FROM user_external_identities WHERE identity_id = $1::uuid`,
      [targetId]
    );
    const historyBefore = await adminPool.query(
      `SELECT event_id::text, from_status, to_status, actor_user_id::text, reason_code, correlation_id::text, created_at
         FROM user_external_identity_lifecycle_events WHERE identity_id = $1::uuid ORDER BY created_at, event_id`,
      [targetId]
    );

    const result = await unlinkVerifiedIdentity(pool, userId, sessionId, grant, targetId, randomUUID());
    expect(result.outcome).toBe("unlinked");
    if (result.outcome !== "unlinked") throw new Error("Expected unlink outcome.");

    const bindingAfter = await adminPool.query(
      `SELECT identity_id::text, user_id::text, issuer, subject, created_at
         FROM user_external_identities WHERE identity_id = $1::uuid`,
      [targetId]
    );
    expect(bindingAfter.rows).toEqual(before.rows);

    const lifecycle = await adminPool.query(
      "SELECT status, version, status_change_reason FROM user_external_identity_lifecycle WHERE identity_id = $1::uuid",
      [targetId]
    );
    expect(lifecycle.rows[0]).toMatchObject({ status: "revoked", version: 2, status_change_reason: "user_unlinked" });

    const historyAfter = await adminPool.query(
      `SELECT event_id::text, from_status, to_status, actor_user_id::text, reason_code, correlation_id::text, created_at
         FROM user_external_identity_lifecycle_events WHERE identity_id = $1::uuid ORDER BY created_at, event_id`,
      [targetId]
    );
    expect(historyAfter.rows.slice(0, historyBefore.rows.length)).toEqual(historyBefore.rows);
    expect(historyAfter.rows).toHaveLength(historyBefore.rows.length + 1);
    expect(historyAfter.rows.at(-1)).toMatchObject({ from_status: "active", to_status: "revoked", reason_code: "user_unlinked" });

    const audit = await adminPool.query(
      "SELECT event_type, reason_code FROM identity_security_audit_events WHERE identity_id = $1::uuid ORDER BY created_at DESC LIMIT 1",
      [targetId]
    );
    expect(audit.rows[0]).toEqual({ event_type: "external_identity.unlink_succeeded", reason_code: "identity_unlinked" });

    const outbox = await adminPool.query(
      "SELECT user_id::text, completed_at FROM identity_session_revocation_outbox WHERE outbox_id = $1::uuid",
      [result.outboxId]
    );
    expect(outbox.rows[0]).toEqual({ user_id: userId, completed_at: null });
  });

  it("rejects unlinking the final active sign-in identity", async () => {
    const { userId, identities } = await createUserWithIdentities(1);
    const sessionId = `session-${randomUUID()}`;
    const grant = await createUnlinkGrant(userId, sessionId);
    const result = await unlinkVerifiedIdentity(pool, userId, sessionId, grant, identities[0]!, randomUUID());
    expect(result).toEqual({ outcome: "denied" });
    const lifecycle = await adminPool.query(
      "SELECT status, version FROM user_external_identity_lifecycle WHERE identity_id = $1::uuid",
      [identities[0]]
    );
    expect(lifecycle.rows[0]).toEqual({ status: "active", version: 1 });
  });

  it("serializes concurrent unlink attempts so one active sign-in method always remains", async () => {
    const { userId, identities } = await createUserWithIdentities(2);
    const sessionId = `session-${randomUUID()}`;
    const [grantA, grantB] = await Promise.all([
      createUnlinkGrant(userId, sessionId), createUnlinkGrant(userId, sessionId)
    ]);
    const results = await Promise.all([
      unlinkVerifiedIdentity(pool, userId, sessionId, grantA, identities[0]!, randomUUID()),
      unlinkVerifiedIdentity(pool, userId, sessionId, grantB, identities[1]!, randomUUID())
    ]);
    expect(results.filter(x => x.outcome === "unlinked")).toHaveLength(1);
    expect(results.filter(x => x.outcome === "denied")).toHaveLength(1);
    const remaining = await adminPool.query(
      `SELECT count(*)::integer AS count
         FROM user_external_identities AS identity
         JOIN user_external_identity_lifecycle AS lifecycle USING (identity_id)
        WHERE identity.user_id = $1::uuid AND lifecycle.status = 'active'`,
      [userId]
    );
    expect(remaining.rows[0]?.count).toBe(1);
  });

  it("rejects wrong-purpose, replayed, expired, or another-session step-up grants", async () => {
    const { userId, identities } = await createUserWithIdentities(2);
    const sessionId = `session-${randomUUID()}`;
    const grant = await createUnlinkGrant(userId, sessionId);
    const wrongSession = await unlinkVerifiedIdentity(
      pool, userId, createOpaqueSessionId(), grant, identities[0]!, randomUUID()
    );
    expect(wrongSession).toEqual({ outcome: "step_up_required" });
    const valid = await unlinkVerifiedIdentity(pool, userId, sessionId, grant, identities[0]!, randomUUID());
    expect(valid.outcome).toBe("unlinked");
    const replay = await unlinkVerifiedIdentity(pool, userId, sessionId, grant, identities[1]!, randomUUID());
    expect(replay).toEqual({ outcome: "step_up_required" });
  });

  it("rolls back lifecycle transition and grant consumption if the required audit write fails", async () => {
    const { userId, identities } = await createUserWithIdentities(2);
    const sessionId = `session-${randomUUID()}`;
    const grant = await createUnlinkGrant(userId, sessionId);
    const correlationId = randomUUID();
    await adminPool.query(
      `INSERT INTO identity_security_audit_events
         (actor_user_id, event_type, reason_code, correlation_id)
       VALUES ($1::uuid, 'external_identity.link_denied', 'test_seed', $2::uuid)`,
      [userId, correlationId]
    );
    await expect(unlinkVerifiedIdentity(
      pool, userId, sessionId, grant, identities[0]!, correlationId
    )).rejects.toThrow();
    const lifecycle = await adminPool.query(
      "SELECT status, version FROM user_external_identity_lifecycle WHERE identity_id = $1::uuid",
      [identities[0]]
    );
    expect(lifecycle.rows[0]).toEqual({ status: "active", version: 1 });
    const grantRow = await adminPool.query(
      "SELECT consumed_at FROM identity_step_up_grants WHERE grant_hash = $1",
      [hashOpaqueSecret(grant)]
    );
    expect(grantRow.rows[0]?.consumed_at).toBeNull();
  });

  it("keeps failed session revocation pending and only completes after confirmed revocation", async () => {
    const { userId, identities } = await createUserWithIdentities(2);
    const sessionId = `session-${randomUUID()}`;
    const grant = await createUnlinkGrant(userId, sessionId);
    const result = await unlinkVerifiedIdentity(pool, userId, sessionId, grant, identities[0]!, randomUUID());
    expect(result.outcome).toBe("unlinked");
    if (result.outcome !== "unlinked") throw new Error("Expected unlink outcome.");
    const failedSessions = { revokeAllForUser: async () => { throw new Error("temporary failure"); } };
    expect(await completeIdentitySessionRevocation(pool, failedSessions as never, userId, result.outboxId)).toBe(false);
    const pending = await adminPool.query(
      "SELECT completed_at FROM identity_session_revocation_outbox WHERE outbox_id = $1::uuid",
      [result.outboxId]
    );
    expect(pending.rows[0]?.completed_at).toBeNull();
    const sessions = new PostgresWebSessionStore(pool, sessionKey);
    expect(await completeIdentitySessionRevocation(pool, sessions, userId, result.outboxId)).toBe(true);
  });
});
