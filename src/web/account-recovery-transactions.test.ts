import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  createOpaqueSessionId,
  encryptAccountRecoveryTransactionPayload
} from "./session-crypto.js";
import { PostgresAccountRecoveryTransactionStore } from "./account-recovery-transactions.js";

const key = Buffer.alloc(32, 23);
const payload = {
  codeVerifier: "A".repeat(64),
  nonce: createOpaqueSessionId()
};

describe("account recovery transaction store", () => {
  it("stores only hashed state and browser binding with encrypted OIDC payload", async () => {
    const pool = {
      query: vi.fn(async () => ({ rows: [], rowCount: 1 }))
    } as unknown as Pool;
    const now = new Date("2026-01-01T00:00:00.000Z");
    const store = new PostgresAccountRecoveryTransactionStore(pool, key, () => now);
    const state = createOpaqueSessionId();
    const binding = createOpaqueSessionId();

    await store.create(state, binding, payload, new Date(now.getTime() + 300_000));
    const [sql, values] = vi.mocked(pool.query).mock.calls[0]!;
    expect(sql).toContain("user_account_recovery_transactions");
    expect(values).not.toContain(state);
    expect(values).not.toContain(binding);
    expect(Buffer.isBuffer(values[0])).toBe(true);
    expect(Buffer.isBuffer(values[1])).toBe(true);
    expect(Buffer.isBuffer(values[2])).toBe(true);
  });

  it("consumes a transaction once and decrypts only after the browser binding matches", async () => {
    const encrypted = encryptAccountRecoveryTransactionPayload(payload, key);
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({
          rows: [{ transaction_id: "30000000-0000-4000-8000-000000000001", encrypted_payload: encrypted }],
          rowCount: 1
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
    } as unknown as Pool;
    const now = new Date("2026-01-01T00:00:00.000Z");
    const store = new PostgresAccountRecoveryTransactionStore(pool, key, () => now);
    const state = createOpaqueSessionId();
    const binding = createOpaqueSessionId();

    await expect(store.consume(state, createOpaqueSessionId())).resolves.toBeNull();
    await expect(store.consume(state, binding)).resolves.toEqual({
      transactionId: "30000000-0000-4000-8000-000000000001",
      payload
    });
    await expect(store.consume(state, binding)).resolves.toBeNull();
  });

  it("rejects transaction lifetimes longer than five minutes", async () => {
    const pool = { query: vi.fn() } as unknown as Pool;
    const now = new Date("2026-01-01T00:00:00.000Z");
    const store = new PostgresAccountRecoveryTransactionStore(pool, key, () => now);
    await expect(store.create(
      createOpaqueSessionId(), createOpaqueSessionId(), payload,
      new Date(now.getTime() + 300_001)
    )).rejects.toThrow("Invalid account recovery transaction");
    expect(pool.query).not.toHaveBeenCalled();
  });
});
