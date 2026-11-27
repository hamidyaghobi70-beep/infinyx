import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  createCsrfToken,
  createOpaqueSessionId,
  decryptSessionTokenBundle,
  encryptSessionTokenBundle
} from "./session-crypto.js";
import { PostgresWebSessionStore } from "./session-store.js";

const key = Buffer.alloc(32, 23);
const userId = "10000000-0000-4000-8000-000000000001";
const issuer = "https://identity.infinyx.test";
const now = new Date("2026-11-27T00:00:00.000Z");

function sessionRow(expiry: number, refreshToken?: string) {
  const csrfToken = createCsrfToken();
  return {
    user_id: userId,
    issuer,
    subject: "subject-1",
    csrf_token_hash: Buffer.alloc(32, 1),
    encrypted_token_bundle: encryptSessionTokenBundle({
      accessToken: "old-access-token",
      ...(refreshToken === undefined ? {} : { refreshToken }),
      accessTokenExpiresAt: expiry,
      csrfToken
    }, key),
    idle_expires_at: new Date(now.getTime() + 1_800_000),
    absolute_expires_at: new Date(now.getTime() + 28_800_000)
  };
}

function fakePool(row: ReturnType<typeof sessionRow>) {
  let stored = { ...row, refresh_attempt_id: null as string | null, revoked_at: null as Date | null };
  const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
  const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
    calls.push({ sql, values });
    if (sql.includes("SELECT user_id::text AS user_id")) {
      const blocked = stored.revoked_at !== null || stored.refresh_attempt_id !== null;
      return { rows: blocked ? [] : [stored], rowCount: blocked ? 0 : 1 };
    }
    if (sql.includes("SET refresh_attempt_id =")) {
      if (stored.refresh_attempt_id || stored.revoked_at ||
          !stored.encrypted_token_bundle.equals(values?.[2] as Buffer)) return { rows: [], rowCount: 0 };
      stored.refresh_attempt_id = values?.[1] as string;
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SET encrypted_token_bundle")) {
      const updatedAt = (values?.[3] as Date).getTime();
      if (updatedAt >= stored.idle_expires_at.getTime() ||
          updatedAt >= stored.absolute_expires_at.getTime() ||
          stored.refresh_attempt_id !== values?.[1]) return { rows: [], rowCount: 0 };
      stored = { ...stored, encrypted_token_bundle: values?.[2] as Buffer, refresh_attempt_id: null };
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SET revoked_at")) {
      stored.revoked_at = values?.[2] as Date ?? values?.[1] as Date;
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: null };
  });
  const pool = { query } as unknown as Pool;
  return { pool, calls, query, get stored() { return stored; } };
}

describe("serialized web-session access-token refresh", () => {
  it("serializes refresh without holding a transaction or row lock, preserving CSRF", async () => {
    const row = sessionRow(now.getTime() + 10_000, "old-refresh-token");
    const csrfToken = decryptSessionTokenBundle(row.encrypted_token_bundle, key).csrfToken;
    const fake = fakePool(row);
    const store = new PostgresWebSessionStore(fake.pool, key, () => now);
    const refresh = vi.fn(async (refreshToken: string) => {
      expect(refreshToken).toBe("old-refresh-token");
      expect(fake.calls.some(call => call.sql === "BEGIN")).toBe(false);
      expect(fake.calls.some(call => call.sql.includes("FOR UPDATE"))).toBe(false);
      return {
        accessToken: "new-access-token",
        refreshToken: "rotated-refresh-token",
        accessTokenExpiresAt: now.getTime() + 300_000
      };
    });

    const accessToken = await store.getUsableAccessToken(createOpaqueSessionId(), refresh);
    expect(accessToken).toBe("new-access-token");
    expect(refresh).toHaveBeenCalledOnce();
    expect(fake.calls.some(call => call.sql.includes("SET refresh_attempt_id ="))).toBe(true);
    expect(fake.calls.some(call => call.sql.includes("refresh_attempt_id = NULL"))).toBe(true);
    expect(fake.calls.some(call => call.sql === "BEGIN")).toBe(false);
    expect(fake.calls.find(call => call.sql.includes("SELECT user_id::text AS user_id"))?.sql)
      .toContain("user_external_identity_lifecycle");
    expect(fake.calls.some(call => call.sql.includes("identity_session_revocation_outbox"))).toBe(true);
    const updated = decryptSessionTokenBundle(fake.stored.encrypted_token_bundle, key);
    expect(updated).toMatchObject({
      accessToken: "new-access-token",
      refreshToken: "rotated-refresh-token",
      csrfToken
    });
  });

  it("does not persist refreshed credentials if the session expires during the provider request", async () => {
    let clock = new Date(now);
    const row = sessionRow(clock.getTime() + 10_000, "refresh-token");
    row.idle_expires_at = new Date(clock.getTime() + 1_000);
    const fake = fakePool(row);
    const store = new PostgresWebSessionStore(fake.pool, key, () => new Date(clock));
    const refresh = vi.fn(async () => {
      clock = new Date(clock.getTime() + 2_000);
      return {
        accessToken: "late-access-token",
        refreshToken: "late-rotated-token",
        accessTokenExpiresAt: clock.getTime() + 300_000
      };
    });

    expect(await store.getUsableAccessToken(createOpaqueSessionId(), refresh)).toBeNull();
    expect(refresh).toHaveBeenCalledOnce();
    expect(decryptSessionTokenBundle(fake.stored.encrypted_token_bundle, key).accessToken)
      .toBe("old-access-token");
  });

  it("returns an access token that is not near expiry without refreshing", async () => {
    const fake = fakePool(sessionRow(now.getTime() + 180_000, "refresh-token"));
    const store = new PostgresWebSessionStore(fake.pool, key, () => now);
    const refresh = vi.fn();
    expect(await store.getUsableAccessToken(createOpaqueSessionId(), refresh)).toBe("old-access-token");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("revokes an expired session when no refresh token is available", async () => {
    const fake = fakePool(sessionRow(now.getTime() - 1, undefined));
    const store = new PostgresWebSessionStore(fake.pool, key, () => now);
    const refresh = vi.fn();
    expect(await store.getUsableAccessToken(createOpaqueSessionId(), refresh)).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
    expect(fake.calls.some(call => call.sql.includes("SET revoked_at"))).toBe(true);
    
  });

  it("revokes the session when refresh fails rather than returning an expired token", async () => {
    const fake = fakePool(sessionRow(now.getTime() - 1, "expired-refresh-token"));
    const store = new PostgresWebSessionStore(fake.pool, key, () => now);
    const refresh = vi.fn(async () => { throw new Error("provider details must not escape"); });
    expect(await store.getUsableAccessToken(createOpaqueSessionId(), refresh)).toBeNull();
    expect(fake.calls.some(call => call.sql.includes("SET revoked_at"))).toBe(true);
    expect(fake.calls.at(-1)?.sql).toContain("SET revoked_at");
  });


  it("fails closed for malformed session identifiers", async () => {
    const fake = fakePool(sessionRow(now.getTime() + 100_000, "refresh-token"));
    const store = new PostgresWebSessionStore(fake.pool, key, () => now);
    expect(await store.getUsableAccessToken("invalid", vi.fn())).toBeNull();
    expect(fake.query).not.toHaveBeenCalled();
  });

  it("fails closed when the account is inactive or has pending revocation", async () => {
    const calls: string[] = [];
    const pool = {
      query: vi.fn(async (sql: string) => {
        calls.push(sql);
        return { rows: [], rowCount: 0 };
      })
    } as unknown as Pool;
    const store = new PostgresWebSessionStore(pool, key, () => now);
    const sessionId = createOpaqueSessionId();

    await expect(store.findActive(sessionId)).resolves.toBeNull();
    await expect(store.touch(sessionId, new Date(now.getTime() + 60_000))).resolves.toBe(false);

    expect(calls).toHaveLength(2);
    for (const sql of calls) {
      expect(sql).toContain("user_account_security");
      expect(sql).toContain("user_external_identities");
      expect(sql).toContain("user_external_identity_lifecycle");
      expect(sql).toContain("lifecycle.status = 'active'");
      expect(sql).toContain("user_account_session_revocation_outbox");
      expect(sql).toContain("account_security.status = 'active'");
    }
  });

  it("refuses to create a session unless the account is active and both revocation barriers are clear", async () => {
    const pool = {
      query: vi.fn(async (sql: string) => {
        expect(sql).toContain("user_account_security");
        expect(sql).toContain("user_external_identities");
        expect(sql).toContain("user_external_identity_lifecycle");
        expect(sql).toContain("lifecycle.status = 'active'");
        expect(sql).toContain("user_account_session_revocation_outbox");
        expect(sql).toContain("identity_session_revocation_outbox");
        return { rows: [], rowCount: 0 };
      })
    } as unknown as Pool;
    const store = new PostgresWebSessionStore(pool, key, () => now);

    await expect(store.create({
      sessionId: createOpaqueSessionId(),
      csrfToken: createCsrfToken(),
      userId,
      issuer,
      subject: "subject-1",
      tokenBundle: {
        accessToken: "access-token",
        accessTokenExpiresAt: now.getTime() + 300_000
      },
      idleExpiresAt: new Date(now.getTime() + 1_800_000),
      absoluteExpiresAt: new Date(now.getTime() + 28_800_000)
    })).rejects.toThrow("Web session operation failed");
  });



});
