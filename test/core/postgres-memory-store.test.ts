import { describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { MemoryValueCipher, type MemoryKeyProvider } from "../../src/core/memory-encryption.js";
import { PostgresEncryptedMemoryStore, type SqlExecutor } from "../../src/core/postgres-memory-store.js";

function keys(): MemoryKeyProvider {
  const key = randomBytes(32);
  return {
    getActiveKey: async () => ({ keyId: "test-key-v1", key }),
    getKey: async (id) => id === "test-key-v1" ? key : null
  };
}

describe("MemoryValueCipher", () => {
  it("round-trips plaintext without storing it in the envelope", async () => {
    const cipher = new MemoryValueCipher(keys());
    const envelope = await cipher.encrypt('{"classification":"internal","value":"hello"}');
    expect(JSON.stringify(envelope)).not.toContain("hello");
    expect(await cipher.decrypt(envelope)).toBe('{"classification":"internal","value":"hello"}');
    expect(envelope.algorithm).toBe("A256GCM");
  });

  it("uses a fresh nonce for every encryption", async () => {
    const cipher = new MemoryValueCipher(keys());
    const a = await cipher.encrypt("same");
    const b = await cipher.encrypt("same");
    expect(a.nonce).not.toBe(b.nonce);
  });

  it("fails closed when ciphertext or authentication tag is changed", async () => {
    const cipher = new MemoryValueCipher(keys());
    const envelope = await cipher.encrypt("secret");
    await expect(cipher.decrypt({ ...envelope, ciphertext: Buffer.from("tampered").toString("base64") }))
      .rejects.toThrow("Memory encryption operation failed.");
  });

  it("re-encrypts an envelope with the active key while retaining old-key reads", async () => {
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    let active = { keyId: "key-v1", key: oldKey };
    const provider: MemoryKeyProvider = {
      getActiveKey: async () => active,
      getKey: async (id) => id === "key-v1" ? oldKey : id === "key-v2" ? newKey : null
    };
    const cipher = new MemoryValueCipher(provider);
    const original = await cipher.encrypt("rotation-check");
    active = { keyId: "key-v2", key: newKey };
    const rotated = await cipher.reencrypt(original);
    expect(rotated.keyId).toBe("key-v2");
    expect(rotated.ciphertext).not.toBe(original.ciphertext);
    expect(await cipher.decrypt(rotated)).toBe("rotation-check");
    expect(await cipher.decrypt(original)).toBe("rotation-check");
  });

  it("fails closed when the key provider cannot return a key", async () => {
    const cipher = new MemoryValueCipher({ getActiveKey: async () => ({ keyId: "missing", key: new Uint8Array(32) }), getKey: async () => null });
    const envelope = await cipher.encrypt("secret");
    await expect(cipher.decrypt(envelope)).rejects.toThrow("Memory encryption operation failed.");
  });
});

describe("PostgresEncryptedMemoryStore", () => {
  it("writes only an authenticated ciphertext envelope and reads it back", async () => {
    const cipher = new MemoryValueCipher(keys());
    let saved: Record<string, unknown> | undefined;
    const db: SqlExecutor = {
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        if (sql.startsWith("INSERT")) {
          saved = JSON.parse(String(values[3])) as Record<string, unknown>;
          return { rows: [], rowCount: 1 };
        }
        if (sql.startsWith("SELECT")) return { rows: saved ? [{ envelope: saved, expires_at: new Date(Date.now() + 60_000) }] : [] };
        return { rows: [], rowCount: 1 };
      })
    };
    const store = new PostgresEncryptedMemoryStore(db, cipher);
    await store.write({ namespace: "tenant-a/notes", key: "k" }, '{"classification":"internal","v":1}');
    expect(JSON.stringify(saved)).not.toContain('"v":1');
    expect(db.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("(tenant_id, namespace, memory_key"),
      expect.arrayContaining(["tenant-a", "tenant-a/notes", "k"])
    );
    expect(await store.read({ namespace: "tenant-a/notes", key: "k" })).toBe('{"classification":"internal","v":1}');
    expect(db.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("WHERE tenant_id = $1"),
      ["tenant-a", "tenant-a/notes", "k"]
    );
  });

  it("deletes expired records before returning a miss", async () => {
    const statements: string[] = [];
    const db: SqlExecutor = {
      query: async (sql) => {
        statements.push(sql);
        if (sql.startsWith("SELECT")) return { rows: [{ envelope: {}, expires_at: new Date(0) }] };
        return { rows: [], rowCount: 1 };
      }
    };
    const store = new PostgresEncryptedMemoryStore(db, new MemoryValueCipher(keys()));
    expect(await store.read({ namespace: "tenant-a/n", key: "k" })).toBeNull();
    expect(statements.some((sql) => sql.startsWith("DELETE"))).toBe(true);
  });

  it("bounds expiry sweeps and includes tenant identity in the delete join", async () => {
    let statement = "";
    const db: SqlExecutor = { query: async (sql) => { statement = sql; return { rows: [], rowCount: 7 }; } };
    const store = new PostgresEncryptedMemoryStore(db, new MemoryValueCipher(keys()));
    await expect(store.deleteExpired(0)).rejects.toThrow(TypeError);
    await expect(store.deleteExpired(500)).resolves.toBe(7);
    expect(statement).toContain("target.tenant_id = expired.tenant_id");
  });

  it("requires an explicit tenant prefix for classified persistent values", async () => {
    const db: SqlExecutor = { query: async () => ({ rows: [], rowCount: 1 }) };
    const store = new PostgresEncryptedMemoryStore(db, new MemoryValueCipher(keys()));
    await expect(store.write({ namespace: "notes", key: "k" }, '{"classification":"internal"}'))
      .rejects.toThrow("tenant scope prefix");
    await expect(store.write({ namespace: "tenant%2fadmin/notes", key: "k" }, '{"classification":"internal"}'))
      .rejects.toThrow("tenant scope prefix");
  });

  it("rejects unclassified and restricted values by default", async () => {
    const db: SqlExecutor = { query: async () => ({ rows: [], rowCount: 1 }) };
    const store = new PostgresEncryptedMemoryStore(db, new MemoryValueCipher(keys()));
    await expect(store.write({ namespace: "n", key: "k" }, '{"v":1}')).rejects.toThrow("classification");
    await expect(store.write({ namespace: "n", key: "k" }, '{"classification":"restricted","secret":"x"}')).rejects.toThrow("classification");
  });

  it("rejects non-serialized values from callers bypassing GuardedMemoryPort", async () => {
    const db: SqlExecutor = { query: async () => ({ rows: [] }) };
    const store = new PostgresEncryptedMemoryStore(db, new MemoryValueCipher(keys()));
    await expect(store.write({ namespace: "n", key: "k" }, { raw: true })).rejects.toThrow(TypeError);
  });
});
