import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { createOpaqueSessionId, encryptOidcLoginPayload } from "./session-crypto.js";
import { PostgresOidcLoginTransactionStore } from "./oidc-login-transactions.js";

const key = Buffer.alloc(32, 19);

function fakePool(rows: unknown[] = [], rowCount = 1) {
  const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows, rowCount }));
  return { pool: { query } as unknown as Pool, query };
}

describe("PostgreSQL OIDC login transaction store", () => {
  it("stores only hashes of state and browser binding and encrypted PKCE data", async () => {
    const fake = fakePool();
    const store = new PostgresOidcLoginTransactionStore(fake.pool, key);
    const state = createOpaqueSessionId();
    const binding = createOpaqueSessionId();
    const payload = { codeVerifier: createOpaqueSessionId(), nonce: createOpaqueSessionId() };
    await store.create(state, binding, payload, new Date(Date.now() + 300_000));
    const [sql, values] = fake.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("INSERT INTO web_login_transactions");
    expect(Buffer.isBuffer(values[0])).toBe(true);
    expect(Buffer.isBuffer(values[1])).toBe(true);
    expect(Buffer.isBuffer(values[2])).toBe(true);
    expect((values[0] as Buffer).toString()).not.toContain(state);
    expect((values[1] as Buffer).toString()).not.toContain(binding);
    expect((values[2] as Buffer).toString()).not.toContain(payload.codeVerifier);
  });

  it("atomically consumes a transaction and returns the decrypted one-time verifier", async () => {
    const payload = { codeVerifier: createOpaqueSessionId(), nonce: createOpaqueSessionId() };
    const encrypted = encryptOidcLoginPayload(payload, key);
    const fake = fakePool([{ encrypted_transaction: encrypted }]);
    const store = new PostgresOidcLoginTransactionStore(fake.pool, key);
    const result = await store.consume(createOpaqueSessionId(), createOpaqueSessionId());
    expect(result).toEqual(payload);
    const sql = fake.query.mock.calls[0]?.[0] as string;
    expect(sql).toContain("SET consumed_at");
    expect(sql).toContain("consumed_at IS NULL");
    expect(sql).toContain("RETURNING encrypted_transaction");
  });

  it("returns null for a replay or mismatched browser binding", async () => {
    const fake = fakePool([]);
    const store = new PostgresOidcLoginTransactionStore(fake.pool, key);
    expect(await store.consume(createOpaqueSessionId(), createOpaqueSessionId())).toBeNull();
  });

  it("rejects transaction lifetimes longer than ten minutes", async () => {
    const fake = fakePool();
    const store = new PostgresOidcLoginTransactionStore(fake.pool, key);
    await expect(store.create(
      createOpaqueSessionId(),
      createOpaqueSessionId(),
      { codeVerifier: createOpaqueSessionId(), nonce: createOpaqueSessionId() },
      new Date(Date.now() + 11 * 60 * 1000)
    )).rejects.toThrow();
  });

  it("purges expired and old consumed records", async () => {
    const fake = fakePool([], 3);
    const store = new PostgresOidcLoginTransactionStore(fake.pool, key);
    expect(await store.purgeExpired()).toBe(3);
    expect(fake.query.mock.calls[0]?.[0]).toContain("DELETE FROM web_login_transactions");
  });
});
