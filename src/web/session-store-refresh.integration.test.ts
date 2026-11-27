import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createPostgresPool } from "../persistence/postgres-pool.js";
import { createCsrfToken, createOpaqueSessionId, decryptSessionTokenBundle } from "./session-crypto.js";
import { PostgresWebSessionStore } from "./session-store.js";

const databaseUrl = process.env.INFINYX_TEST_DATABASE_URL;
const integrationDescribe = databaseUrl ? describe : describe.skip;
const encryptionKey = Buffer.alloc(32, 47);

integrationDescribe("PostgreSQL web-session refresh advisory lock", () => {
  let pool: ReturnType<typeof createPostgresPool>;
  let adminPool: ReturnType<typeof createPostgresPool>;

  beforeAll(() => {
    pool = createPostgresPool({
      DATABASE_URL: databaseUrl!, DATABASE_SSL: "disable",
      DATABASE_POOL_MAX: "6", DATABASE_CONNECTION_TIMEOUT_MS: "5000",
      DATABASE_IDLE_TIMEOUT_MS: "1000", DATABASE_STATEMENT_TIMEOUT_MS: "5000"
    });
    adminPool = createPostgresPool({
      DATABASE_URL: process.env.DATABASE_URL!, DATABASE_SSL: "disable",
      DATABASE_POOL_MAX: "3", DATABASE_CONNECTION_TIMEOUT_MS: "5000",
      DATABASE_IDLE_TIMEOUT_MS: "1000", DATABASE_STATEMENT_TIMEOUT_MS: "5000"
    });
  });

  afterAll(async () => {
    if (pool) await pool.end();
    if (adminPool) await adminPool.end();
  });

  it("allows only one concurrent refresh for the same session across separate pool connections", async () => {
    const userId = randomUUID();
    const issuer = `https://refresh-lock-${randomUUID()}.example.test`;
    const subject = `subject-${randomUUID()}`;
    const sessionId = createOpaqueSessionId();
    const csrfToken = createCsrfToken();
    const now = new Date();
    // Track checked-out clients at the PoolClient boundary. pg.Pool.totalCount
    // also includes idle clients and cannot prove simultaneous checkout.
    let checkedOut = 0;
    let peakCheckedOut = 0;
    const trackedPool = {
      connect: async () => {
        const client = await pool.connect();
        checkedOut += 1;
        peakCheckedOut = Math.max(peakCheckedOut, checkedOut);
        const release = client.release.bind(client);
        client.release = (error?: Error | boolean) => {
          checkedOut -= 1;
          release(error);
        };
        return client;
      }
    } as unknown as Pool;
    const store = new PostgresWebSessionStore(trackedPool, encryptionKey);

    let signalRefreshStarted!: () => void;
    const refreshStarted = new Promise<void>(resolve => { signalRefreshStarted = resolve; });
    let finishRefresh: () => void = () => {};
    const refreshGate = new Promise<void>(resolve => { finishRefresh = resolve; });
    let refreshCalls = 0;
    const refresh = async (token: string) => {
      refreshCalls += 1;
      expect(token).toBe("single-use-refresh-token");
      signalRefreshStarted();
      await refreshGate;
      return {
        accessToken: "rotated-access-token",
        refreshToken: "rotated-refresh-token",
        accessTokenExpiresAt: Date.now() + 300_000
      };
    };

    try {
      await adminPool.query("INSERT INTO users (id) VALUES ($1::uuid)", [userId]);
      await adminPool.query(
        "INSERT INTO user_external_identities (user_id, issuer, subject) VALUES ($1::uuid, $2, $3)",
        [userId, issuer, subject]
      );

      // Seed the fixture with the migration/admin connection; the app-role pool
      // remains the subject of the refresh, advisory-lock, and CAS assertions.
      await new PostgresWebSessionStore(adminPool, encryptionKey).create({
        sessionId, csrfToken, userId, issuer, subject,
        tokenBundle: {
          accessToken: "expired-access-token",
          refreshToken: "single-use-refresh-token",
          accessTokenExpiresAt: now.getTime() - 1,
          csrfToken
        },
        idleExpiresAt: new Date(now.getTime() + 1_800_000),
        absoluteExpiresAt: new Date(now.getTime() + 28_800_000)
      });

      const first = store.getUsableAccessToken(sessionId, refresh);
      await refreshStarted;
      const second = await store.getUsableAccessToken(sessionId, refresh);
      expect(second).toBeNull();
      expect(refreshCalls).toBe(1);
      // The first provider callback is still blocked while the second call
      // attempts the advisory lock. Both PoolClients must therefore overlap.
      // peakCheckedOut measures checked-out clients, excluding idle pool clients.
      expect(checkedOut).toBe(1);
      expect(peakCheckedOut).toBe(2);

      finishRefresh();
      await expect(first).resolves.toBe("rotated-access-token");
      expect(refreshCalls).toBe(1);

      const persisted = await adminPool.query<{ encrypted_token_bundle: Buffer }>(
        "SELECT encrypted_token_bundle FROM web_sessions WHERE user_id = $1::uuid",
        [userId]
      );
      expect(persisted.rows).toHaveLength(1);
      expect(persisted.rows[0]?.encrypted_token_bundle).toBeInstanceOf(Buffer);
      expect(decryptSessionTokenBundle(persisted.rows[0]!.encrypted_token_bundle, encryptionKey))
        .toMatchObject({ accessToken: "rotated-access-token", refreshToken: "rotated-refresh-token", csrfToken });
    } finally {
      finishRefresh();
      await adminPool.query("DELETE FROM web_sessions WHERE user_id = $1::uuid", [userId]);
      // External-identity lifecycle and audit rows are intentionally append-only
      // (their schema rejects deletion); use unique fixture identifiers per run.
    }
  });
});
