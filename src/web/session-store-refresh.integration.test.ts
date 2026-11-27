import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresPool } from "../persistence/postgres-pool.js";
import { createCsrfToken, createOpaqueSessionId, decryptSessionTokenBundle, hashOpaqueSecret } from "./session-crypto.js";
import { PostgresWebSessionStore, WebSessionStoreError } from "./session-store.js";

const databaseUrl = process.env.INFINYX_TEST_DATABASE_URL;
const integrationDescribe = databaseUrl ? describe : describe.skip;
const encryptionKey = Buffer.alloc(32, 47);

integrationDescribe("PostgreSQL durable web-session refresh reservation", () => {
  let appPool: ReturnType<typeof createPostgresPool>;
  let adminPool: ReturnType<typeof createPostgresPool>;
  let recoveryPool: ReturnType<typeof createPostgresPool> | undefined;
  let appPoolEnded = false;

  beforeAll(() => {
    appPool = createPostgresPool({
      DATABASE_URL: databaseUrl!, DATABASE_SSL: "disable",
      DATABASE_POOL_MAX: "4", DATABASE_CONNECTION_TIMEOUT_MS: "5000",
      DATABASE_IDLE_TIMEOUT_MS: "1000", DATABASE_STATEMENT_TIMEOUT_MS: "5000"
    });
    adminPool = createPostgresPool({
      DATABASE_URL: process.env.DATABASE_URL!, DATABASE_SSL: "disable",
      DATABASE_POOL_MAX: "3", DATABASE_CONNECTION_TIMEOUT_MS: "5000",
      DATABASE_IDLE_TIMEOUT_MS: "1000", DATABASE_STATEMENT_TIMEOUT_MS: "5000"
    });
  });

  afterAll(async () => {
    if (appPool && !appPoolEnded) await appPool.end();
    if (recoveryPool) await recoveryPool.end();
    if (adminPool) await adminPool.end();
  });

  it("persists one rotated token bundle and clears the reservation after successful refresh", async () => {
    const userId = randomUUID();
    const issuer = `https://refresh-success-${randomUUID()}.example.test`;
    const subject = `subject-${randomUUID()}`;
    const sessionId = createOpaqueSessionId();
    const csrfToken = createCsrfToken();
    const now = new Date();
    let signalRefreshStarted!: () => void;
    let finishRefresh!: () => void;
    const refreshStarted = new Promise<void>(resolve => { signalRefreshStarted = resolve; });
    const refreshGate = new Promise<void>(resolve => { finishRefresh = resolve; });
    let providerCalls = 0;

    try {
      await adminPool.query("INSERT INTO users (id) VALUES ($1::uuid)", [userId]);
      await adminPool.query(
        "INSERT INTO user_external_identities (user_id, issuer, subject) VALUES ($1::uuid, $2, $3)",
        [userId, issuer, subject]
      );
      await new PostgresWebSessionStore(adminPool, encryptionKey).create({
        sessionId, csrfToken, userId, issuer, subject,
        tokenBundle: {
          accessToken: "expired-access-token",
          refreshToken: "single-use-refresh-token",
          accessTokenExpiresAt: now.getTime() - 1
        },
        idleExpiresAt: new Date(now.getTime() + 1_800_000),
        absoluteExpiresAt: new Date(now.getTime() + 28_800_000)
      });

      const store = new PostgresWebSessionStore(appPool, encryptionKey);
      const first = store.getUsableAccessToken(sessionId, async token => {
        providerCalls += 1;
        expect(token).toBe("single-use-refresh-token");
        signalRefreshStarted();
        await refreshGate;
        return {
          accessToken: "rotated-access-token",
          refreshToken: "rotated-refresh-token",
          accessTokenExpiresAt: Date.now() + 300_000
        };
      });
      await refreshStarted;

      const second = await store.getUsableAccessToken(sessionId, async () => {
        providerCalls += 1;
        return { accessToken: "unexpected", accessTokenExpiresAt: Date.now() + 300_000 };
      });
      expect(second).toBeNull();
      expect(providerCalls).toBe(1);

      finishRefresh();
      await expect(first).resolves.toBe("rotated-access-token");

      const persisted = await adminPool.query<{ encrypted_token_bundle: Buffer; refresh_attempt_id: string | null }>(
        "SELECT encrypted_token_bundle, refresh_attempt_id FROM web_sessions WHERE session_id_hash = $1",
        [hashOpaqueSecret(sessionId)]
      );
      expect(persisted.rows).toHaveLength(1);
      expect(persisted.rows[0]?.refresh_attempt_id).toBeNull();
      expect(decryptSessionTokenBundle(persisted.rows[0]!.encrypted_token_bundle, encryptionKey))
        .toMatchObject({
          accessToken: "rotated-access-token",
          refreshToken: "rotated-refresh-token",
          csrfToken
        });
    } finally {
      finishRefresh?.();
      await adminPool.query("DELETE FROM web_sessions WHERE user_id = $1::uuid", [userId]);
    }
  });

  it("keeps a durable reservation when the app pool disconnects mid-refresh", async () => {
    const userId = randomUUID();
    const issuer = `https://refresh-disconnect-${randomUUID()}.example.test`;
    const subject = `subject-${randomUUID()}`;
    const sessionId = createOpaqueSessionId();
    const csrfToken = createCsrfToken();
    const now = new Date();
    let signalRefreshStarted!: () => void;
    let finishRefresh!: () => void;
    const refreshStarted = new Promise<void>(resolve => { signalRefreshStarted = resolve; });
    const refreshGate = new Promise<void>(resolve => { finishRefresh = resolve; });
    let providerCalls = 0;

    try {
      await adminPool.query("INSERT INTO users (id) VALUES ($1::uuid)", [userId]);
      await adminPool.query(
        "INSERT INTO user_external_identities (user_id, issuer, subject) VALUES ($1::uuid, $2, $3)",
        [userId, issuer, subject]
      );
      await new PostgresWebSessionStore(adminPool, encryptionKey).create({
        sessionId, csrfToken, userId, issuer, subject,
        tokenBundle: {
          accessToken: "expired-access-token",
          refreshToken: "single-use-refresh-token",
          accessTokenExpiresAt: now.getTime() - 1
        },
        idleExpiresAt: new Date(now.getTime() + 1_800_000),
        absoluteExpiresAt: new Date(now.getTime() + 28_800_000)
      });

      const store = new PostgresWebSessionStore(appPool, encryptionKey);
      const first = store.getUsableAccessToken(sessionId, async () => {
        providerCalls += 1;
        signalRefreshStarted();
        await refreshGate;
        return {
          accessToken: "rotated-access-token",
          refreshToken: "rotated-refresh-token",
          accessTokenExpiresAt: Date.now() + 300_000
        };
      });
      await refreshStarted;

      const competing = await store.getUsableAccessToken(sessionId, async () => {
        providerCalls += 1;
        return { accessToken: "unexpected", accessTokenExpiresAt: Date.now() + 300_000 };
      });
      expect(competing).toBeNull();
      expect(providerCalls).toBe(1);

      // The provider request is still pending. Ending the pool simulates the
      // PostgreSQL connection becoming unavailable during the external call.
      await appPool.end();
      appPoolEnded = true;
      recoveryPool = createPostgresPool({
        DATABASE_URL: databaseUrl!, DATABASE_SSL: "disable",
        DATABASE_POOL_MAX: "2", DATABASE_CONNECTION_TIMEOUT_MS: "5000",
        DATABASE_IDLE_TIMEOUT_MS: "1000", DATABASE_STATEMENT_TIMEOUT_MS: "5000"
      });
      const recoveredStore = new PostgresWebSessionStore(recoveryPool, encryptionKey);
      const retry = await recoveredStore.getUsableAccessToken(sessionId, async () => {
        providerCalls += 1;
        return { accessToken: "unsafe-retry", accessTokenExpiresAt: Date.now() + 300_000 };
      });
      expect(retry).toBeNull();
      expect(providerCalls).toBe(1);

      finishRefresh();
      await expect(first).rejects.toBeInstanceOf(WebSessionStoreError);

      const persisted = await adminPool.query<{ refresh_attempt_id: string | null; revoked_at: Date | null }>(
        "SELECT refresh_attempt_id, revoked_at FROM web_sessions WHERE session_id_hash = $1",
        [hashOpaqueSecret(sessionId)]
      );
      expect(persisted.rows).toHaveLength(1);
      expect(persisted.rows[0]?.refresh_attempt_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
      );
      expect(persisted.rows[0]?.revoked_at).toBeNull();
    } finally {
      finishRefresh?.();
      await adminPool.query("DELETE FROM web_sessions WHERE user_id = $1::uuid", [userId]);
    }
  });
});
