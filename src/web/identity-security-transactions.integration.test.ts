import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresPool } from "../persistence/postgres-pool.js";
import { createOpaqueSessionId } from "./session-crypto.js";
import { PostgresIdentitySecurityTransactionStore } from "./identity-security-transactions.js";

const databaseUrl = process.env.INFINYX_TEST_DATABASE_URL;
const integrationDescribe = databaseUrl ? describe : describe.skip;
const key = Buffer.alloc(32, 29);

integrationDescribe("PostgreSQL identity security transaction persistence", () => {
  let pool: ReturnType<typeof createPostgresPool>;
  let adminPool: ReturnType<typeof createPostgresPool>;

  beforeAll(() => {
    pool = createPostgresPool({
      DATABASE_URL: databaseUrl!,
      DATABASE_SSL: "disable",
      DATABASE_POOL_MAX: "6",
      DATABASE_CONNECTION_TIMEOUT_MS: "5000",
      DATABASE_IDLE_TIMEOUT_MS: "1000",
      DATABASE_STATEMENT_TIMEOUT_MS: "5000"
    });
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
    if (pool) await pool.end();
    if (adminPool) await adminPool.end();
  });

  it("binds transactions and grants to one user/session and permits only one concurrent consume", async () => {
    const userId = randomUUID();
    const otherUserId = randomUUID();
    const sessionId = createOpaqueSessionId();
    const otherSessionId = createOpaqueSessionId();
    const browserBinding = createOpaqueSessionId();
    const state = createOpaqueSessionId();
    const payload = {
      codeVerifier: createOpaqueSessionId(),
      nonce: createOpaqueSessionId()
    };
    const store = new PostgresIdentitySecurityTransactionStore(pool, key);
    const beforeIdentityBindings = await adminPool.query(
      "SELECT count(*)::integer AS count FROM user_external_identities"
    );

    await adminPool.query("INSERT INTO users (id) VALUES ($1::uuid), ($2::uuid)", [
      userId, otherUserId
    ]);

    try {
      await store.createTransaction(
        state, browserBinding, userId, sessionId, "reauth_identity_link",
        payload, new Date(Date.now() + 4 * 60 * 1000)
      );

      expect(await store.consumeTransaction(
        state, browserBinding, otherUserId, sessionId, "reauth_identity_link"
      )).toBeNull();
      expect(await store.consumeTransaction(
        state, browserBinding, userId, otherSessionId, "reauth_identity_link"
      )).toBeNull();
      expect(await store.consumeTransaction(
        state, browserBinding, userId, sessionId, "reauth_identity_unlink"
      )).toBeNull();

      const consumed = await Promise.all([
        store.consumeTransaction(state, browserBinding, userId, sessionId, "reauth_identity_link"),
        store.consumeTransaction(state, browserBinding, userId, sessionId, "reauth_identity_link")
      ]);
      const winners = consumed.filter((item) => item !== null);
      expect(winners).toHaveLength(1);
      expect(winners[0]?.payload).toEqual(payload);

      const transactionId = winners[0]!.transactionId;
      const grant = await store.issueVerifiedStepUpGrant(
        transactionId, userId, sessionId, "identity_link",
        new Date(Date.now() + 4 * 60 * 1000)
      );
      expect(grant).toBeTruthy();

      expect(await store.consumeStepUpGrant(
        grant!, otherUserId, sessionId, "identity_link"
      )).toBe(false);
      expect(await store.consumeStepUpGrant(
        grant!, userId, otherSessionId, "identity_link"
      )).toBe(false);
      expect(await store.consumeStepUpGrant(
        grant!, userId, sessionId, "identity_unlink"
      )).toBe(false);

      const grantConsumes = await Promise.all([
        store.consumeStepUpGrant(grant!, userId, sessionId, "identity_link"),
        store.consumeStepUpGrant(grant!, userId, sessionId, "identity_link")
      ]);
      expect(grantConsumes.filter(Boolean)).toHaveLength(1);

      const afterIdentityBindings = await adminPool.query(
        "SELECT count(*)::integer AS count FROM user_external_identities"
      );
      expect(afterIdentityBindings.rows[0]?.count).toBe(beforeIdentityBindings.rows[0]?.count);
    } finally {
      await adminPool.query(
        "DELETE FROM identity_step_up_grants WHERE user_id IN ($1::uuid, $2::uuid)",
        [userId, otherUserId]
      );
      await adminPool.query(
        "DELETE FROM identity_security_transactions WHERE user_id IN ($1::uuid, $2::uuid)",
        [userId, otherUserId]
      );
      await adminPool.query("DELETE FROM users WHERE id IN ($1::uuid, $2::uuid)", [
        userId, otherUserId
      ]);
    }
  });

  it("enforces database checks for malformed hashes and invalid purpose values", async () => {
    const userId = randomUUID();
    await adminPool.query("INSERT INTO users (id) VALUES ($1::uuid)", [userId]);
    try {
      await expect(adminPool.query(
        `INSERT INTO identity_security_transactions
           (state_hash, user_id, session_id_hash, browser_binding_hash,
            purpose, encrypted_payload, expires_at)
         VALUES ($1, $2::uuid, $3, $4, 'unknown', $5, now() + interval '1 minute')`,
        [Buffer.alloc(32), userId, Buffer.alloc(32), Buffer.alloc(32), Buffer.alloc(64)]
      )).rejects.toThrow();

      await expect(adminPool.query(
        `INSERT INTO identity_security_transactions
           (state_hash, user_id, session_id_hash, browser_binding_hash,
            purpose, encrypted_payload, expires_at)
         VALUES ($1, $2::uuid, $3, $4, 'reauth_identity_link', $5, now() + interval '1 minute')`,
        [Buffer.alloc(31), userId, Buffer.alloc(32), Buffer.alloc(32), Buffer.alloc(64)]
      )).rejects.toThrow();
    } finally {
      await adminPool.query("DELETE FROM users WHERE id = $1::uuid", [userId]);
    }
  });
});
