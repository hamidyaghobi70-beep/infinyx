import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  createOpaqueSessionId,
  encryptIdentitySecurityTransactionPayload
} from "./session-crypto.js";
import { PostgresIdentitySecurityTransactionStore } from "./identity-security-transactions.js";

const key = Buffer.alloc(32, 23);
const userId = "10000000-0000-4000-8000-000000000001";
const transactionId = "20000000-0000-4000-8000-000000000001";

function fakePool(
  responses: Array<{ rows?: unknown[]; rowCount?: number }> = []
) {
  const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) =>
    responses.shift() ?? { rows: [], rowCount: 0 }
  );
  return { pool: { query } as unknown as Pool, query };
}

function transactionInputs() {
  return {
    state: createOpaqueSessionId(),
    browserBinding: createOpaqueSessionId(),
    sessionId: createOpaqueSessionId(),
    payload: {
      codeVerifier: createOpaqueSessionId(),
      nonce: createOpaqueSessionId()
    },
    expiresAt: new Date(Date.now() + 4 * 60 * 1000)
  };
}

describe("PostgreSQL identity security transaction store", () => {
  it("stores only hashes of state, browser binding, and session plus encrypted callback data", async () => {
    const fake = fakePool([{ rows: [], rowCount: 1 }]);
    const store = new PostgresIdentitySecurityTransactionStore(fake.pool, key);
    const input = transactionInputs();
    await store.createTransaction(
      input.state, input.browserBinding, userId, input.sessionId,
      "reauth_identity_link", input.payload, input.expiresAt
    );
    const [sql, values] = fake.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("INSERT INTO identity_security_transactions");
    expect(Buffer.isBuffer(values[0])).toBe(true);
    expect(Buffer.isBuffer(values[2])).toBe(true);
    expect(Buffer.isBuffer(values[3])).toBe(true);
    expect(Buffer.isBuffer(values[5])).toBe(true);
    expect((values[0] as Buffer).toString()).not.toContain(input.state);
    expect((values[2] as Buffer).toString()).not.toContain(input.sessionId);
    expect((values[3] as Buffer).toString()).not.toContain(input.browserBinding);
    expect((values[5] as Buffer).toString()).not.toContain(input.payload.codeVerifier);
  });

  it("atomically consumes a matching transaction and decrypts its one-time payload", async () => {
    const input = transactionInputs();
    const encrypted = encryptIdentitySecurityTransactionPayload(input.payload, key);
    const fake = fakePool([{
      rows: [{ transaction_id: transactionId, encrypted_payload: encrypted }],
      rowCount: 1
    }]);
    const store = new PostgresIdentitySecurityTransactionStore(fake.pool, key);
    const result = await store.consumeTransaction(
      input.state, input.browserBinding, userId, input.sessionId, "reauth_identity_link"
    );
    expect(result).toEqual({ transactionId, payload: input.payload });
    const sql = fake.query.mock.calls[0]?.[0] as string;
    expect(sql).toContain("SET consumed_at");
    expect(sql).toContain("consumed_at IS NULL");
    expect(sql).toContain("expires_at >");
    expect(sql).toContain("browser_binding_hash =");
    expect(sql).toContain("session_id_hash =");
    expect(sql).toContain("purpose =");
  });

  it("fails closed for replay, another user, another session, or another purpose", async () => {
    const fake = fakePool([{ rows: [], rowCount: 0 }]);
    const store = new PostgresIdentitySecurityTransactionStore(fake.pool, key);
    const input = transactionInputs();
    expect(await store.consumeTransaction(
      input.state, input.browserBinding, userId, input.sessionId, "reauth_identity_unlink"
    )).toBeNull();
    expect(fake.query.mock.calls[0]?.[0]).toContain("user_id =");
    expect(fake.query.mock.calls[0]?.[0]).toContain("session_id_hash =");
  });

  it("issues a single purpose-bound grant only from a recently consumed matching transaction", async () => {
    const fake = fakePool([{ rows: [], rowCount: 1 }]);
    const store = new PostgresIdentitySecurityTransactionStore(fake.pool, key);
    const sessionId = createOpaqueSessionId();
    const grant = await store.issueVerifiedStepUpGrant(
      transactionId, userId, sessionId, "identity_link",
      new Date(Date.now() + 4 * 60 * 1000)
    );
    expect(grant).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const [sql, values] = fake.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("INSERT INTO identity_step_up_grants");
    expect(sql).toContain("consumed_at IS NOT NULL");
    expect(sql).toContain("ON CONFLICT DO NOTHING");
    expect(values[4]).toBe("identity_link");
    expect(values[7]).toBe("reauth_identity_link");
    expect(Buffer.isBuffer(values[0])).toBe(true);
    expect((values[0] as Buffer).toString()).not.toContain(grant);
  });

  it("atomically consumes a step-up grant once and binds it to user, session, and purpose", async () => {
    const fake = fakePool([{ rows: [], rowCount: 1 }]);
    const store = new PostgresIdentitySecurityTransactionStore(fake.pool, key);
    const grant = createOpaqueSessionId();
    const sessionId = createOpaqueSessionId();
    expect(await store.consumeStepUpGrant(
      grant, userId, sessionId, "identity_unlink"
    )).toBe(true);
    const sql = fake.query.mock.calls[0]?.[0] as string;
    expect(sql).toContain("UPDATE identity_step_up_grants");
    expect(sql).toContain("consumed_at IS NULL");
    expect(sql).toContain("expires_at >");
    expect(sql).toContain("user_id =");
    expect(sql).toContain("session_id_hash =");
    expect(sql).toContain("purpose =");
  });

  it("rejects transaction and grant lifetimes beyond five minutes", async () => {
    const fake = fakePool();
    const store = new PostgresIdentitySecurityTransactionStore(fake.pool, key);
    const input = transactionInputs();
    await expect(store.createTransaction(
      input.state, input.browserBinding, userId, input.sessionId,
      "reauth_identity_link", input.payload, new Date(Date.now() + 6 * 60 * 1000)
    )).rejects.toThrow();
    await expect(store.issueVerifiedStepUpGrant(
      transactionId, userId, input.sessionId, "identity_link",
      new Date(Date.now() + 6 * 60 * 1000)
    )).rejects.toThrow();
    expect(fake.query).not.toHaveBeenCalled();
  });

  it("purges expired grants before their source transactions", async () => {
    const fake = fakePool([
      { rows: [], rowCount: 2 },
      { rows: [], rowCount: 3 }
    ]);
    const store = new PostgresIdentitySecurityTransactionStore(fake.pool, key);
    expect(await store.purgeExpired()).toBe(5);
    expect(fake.query.mock.calls[0]?.[0]).toContain("DELETE FROM identity_step_up_grants");
    expect(fake.query.mock.calls[1]?.[0]).toContain("DELETE FROM identity_security_transactions");
    expect(fake.query.mock.calls[1]?.[0]).toContain("NOT EXISTS");
    expect(fake.query.mock.calls[1]?.[0]).toContain("consumed_at IS NULL");
  });
});
