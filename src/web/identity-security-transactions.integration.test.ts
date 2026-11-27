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
      expect(await store.issueVerifiedStepUpGrant(
        transactionId, otherUserId, sessionId, "identity_link",
        new Date(Date.now() + 4 * 60 * 1000)
      )).toBeNull();
      expect(await store.issueVerifiedStepUpGrant(
        transactionId, userId, otherSessionId, "identity_link",
        new Date(Date.now() + 4 * 60 * 1000)
      )).toBeNull();
      expect(await store.issueVerifiedStepUpGrant(
        transactionId, userId, sessionId, "identity_unlink",
        new Date(Date.now() + 4 * 60 * 1000)
      )).toBeNull();
      const grant = await store.issueVerifiedStepUpGrant(
        transactionId, userId, sessionId, "identity_link",
        new Date(Date.now() + 4 * 60 * 1000)
      );
      expect(grant).toBeTruthy();

      await expect(pool.query(
        `UPDATE identity_security_transactions
            SET user_id = $2::uuid
          WHERE transaction_id = $1::uuid`,
        [transactionId, otherUserId]
      )).rejects.toThrow();
      const storedGrant = await pool.query<{ grant_hash: Buffer }>(
        "SELECT grant_hash FROM identity_step_up_grants WHERE source_transaction_id = $1::uuid",
        [transactionId]
      );
      await expect(pool.query(
        `UPDATE identity_step_up_grants
            SET purpose = 'identity_unlink'
          WHERE grant_hash = $1`,
        [storedGrant.rows[0]!.grant_hash]
      )).rejects.toThrow();

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

  it("rejects expired transactions and step-up grants using database timestamps", async () => {
    const userId = randomUUID();
    let clock = new Date();
    const store = new PostgresIdentitySecurityTransactionStore(pool, key, () => new Date(clock));
    const payload = {
      codeVerifier: createOpaqueSessionId(),
      nonce: createOpaqueSessionId()
    };
    await adminPool.query("INSERT INTO users (id) VALUES ($1::uuid)", [userId]);

    try {
      const expiredState = createOpaqueSessionId();
      const expiredBinding = createOpaqueSessionId();
      const expiredSession = createOpaqueSessionId();
      await store.createTransaction(
        expiredState, expiredBinding, userId, expiredSession,
        "reauth_identity_link", payload, new Date(clock.getTime() + 60_000)
      );
      clock = new Date(clock.getTime() + 2 * 60 * 1000);
      expect(await store.consumeTransaction(
        expiredState, expiredBinding, userId, expiredSession, "reauth_identity_link"
      )).toBeNull();

      clock = new Date();
      const state = createOpaqueSessionId();
      const binding = createOpaqueSessionId();
      const session = createOpaqueSessionId();
      await store.createTransaction(
        state, binding, userId, session,
        "reauth_identity_link", payload, new Date(clock.getTime() + 4 * 60 * 1000)
      );
      const consumed = await store.consumeTransaction(
        state, binding, userId, session, "reauth_identity_link"
      );
      expect(consumed).not.toBeNull();
      const grant = await store.issueVerifiedStepUpGrant(
        consumed!.transactionId, userId, session, "identity_link",
        new Date(clock.getTime() + 4 * 60 * 1000)
      );
      expect(grant).toBeTruthy();
      clock = new Date(clock.getTime() + 6 * 60 * 1000);
      expect(await store.consumeStepUpGrant(
        grant!, userId, session, "identity_link"
      )).toBe(false);
    } finally {
      await adminPool.query(
        "DELETE FROM identity_step_up_grants WHERE user_id = $1::uuid", [userId]
      );
      await adminPool.query(
        "DELETE FROM identity_security_transactions WHERE user_id = $1::uuid", [userId]
      );
      await adminPool.query("DELETE FROM users WHERE id = $1::uuid", [userId]);
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

      await expect(adminPool.query(
        `INSERT INTO identity_security_transactions
           (state_hash, user_id, session_id_hash, browser_binding_hash,
            purpose, encrypted_payload, expires_at)
         VALUES ($1, $2::uuid, $3, $4, 'reauth_identity_link', $5, now() + interval '6 minutes')`,
        [Buffer.alloc(32, 1), userId, Buffer.alloc(32), Buffer.alloc(32), Buffer.alloc(64)]
      )).rejects.toThrow();
    } finally {
      await adminPool.query("DELETE FROM users WHERE id = $1::uuid", [userId]);
    }
  });
  it("atomically consumes a step-up grant while creating one purpose-bound link transaction", async () => {
    const userId = randomUUID();
    const sessionId = createOpaqueSessionId();
    const payload = {
      codeVerifier: createOpaqueSessionId(),
      nonce: createOpaqueSessionId()
    };
    const store = new PostgresIdentitySecurityTransactionStore(pool, key);
    const reauthState = createOpaqueSessionId();
    const reauthBinding = createOpaqueSessionId();
    const reauth = await adminPool.query(
      "INSERT INTO users (id) VALUES ($1::uuid)",
      [userId]
    );
    expect(reauth.rowCount).toBe(1);
    const linkState = createOpaqueSessionId();
    const linkBinding = createOpaqueSessionId();

    try {
      await store.createTransaction(
        reauthState, reauthBinding, userId, sessionId,
        "reauth_identity_link", payload, new Date(Date.now() + 4 * 60 * 1000)
      );
      const consumed = await store.consumeTransaction(
        reauthState, reauthBinding, userId, sessionId, "reauth_identity_link"
      );
      expect(consumed).toBeTruthy();
      const grant = await store.issueVerifiedStepUpGrant(
        consumed!.transactionId, userId, sessionId, "identity_link",
        new Date(Date.now() + 4 * 60 * 1000)
      );
      expect(grant).toBeTruthy();

      await store.createLinkTransactionFromStepUpGrant(
        grant!, linkState, linkBinding, userId, sessionId,
        payload, new Date(Date.now() + 4 * 60 * 1000)
      );
      await expect(store.createLinkTransactionFromStepUpGrant(
        grant!, createOpaqueSessionId(), createOpaqueSessionId(), userId, sessionId,
        payload, new Date(Date.now() + 4 * 60 * 1000)
      )).rejects.toThrow();

      const linkTransactions = await adminPool.query(
        "SELECT purpose, user_id::text, session_id_hash, browser_binding_hash FROM identity_security_transactions WHERE user_id = $1::uuid AND purpose = 'identity_link'",
        [userId]
      );
      expect(linkTransactions.rows).toHaveLength(1);
      expect(linkTransactions.rows[0]?.purpose).toBe("identity_link");
      const grantRows = await adminPool.query(
        "SELECT consumed_at FROM identity_step_up_grants WHERE user_id = $1::uuid",
        [userId]
      );
      expect(grantRows.rows[0]?.consumed_at).toBeTruthy();
    } finally {
      await adminPool.query("DELETE FROM identity_step_up_grants WHERE user_id = $1::uuid", [userId]);
      await adminPool.query("DELETE FROM identity_security_transactions WHERE user_id = $1::uuid", [userId]);
      await adminPool.query("DELETE FROM users WHERE id = $1::uuid", [userId]);
    }
  });

});
