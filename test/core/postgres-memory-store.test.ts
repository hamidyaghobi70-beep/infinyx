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

  it("binds v2 ciphertext to tenant, namespace, and record key while preserving v1 reads", async () => {
    const cipher = new MemoryValueCipher(keys());
    const context = { tenantId: "tenant-a", namespace: "tenant-a/notes", key: "record-1" };
    const envelope = await cipher.encrypt("context-bound", context);
    expect(envelope.formatVersion).toBe(2);
    await expect(cipher.decrypt(envelope)).rejects.toThrow("Memory encryption operation failed.");
    await expect(cipher.decrypt(envelope, { ...context, key: "record-2" }))
      .rejects.toThrow("Memory encryption operation failed.");
    await expect(cipher.decrypt(envelope, { ...context, tenantId: "tenant-b" }))
      .rejects.toThrow("Memory encryption operation failed.");
    await expect(cipher.decrypt(envelope, context)).resolves.toBe("context-bound");
    const legacy = await cipher.encrypt("legacy-v1");
    expect(legacy.formatVersion).toBe(1);
    await expect(cipher.decrypt(legacy)).resolves.toBe("legacy-v1");
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

  it("rejects non-canonical Base64 envelope fields", async () => {
    const cipher = new MemoryValueCipher(keys());
    const envelope = await cipher.encrypt("strict-envelope");
    await expect(cipher.decrypt({ ...envelope, nonce: "!!!!" }))
      .rejects.toThrow("Memory encryption operation failed.");
    await expect(cipher.decrypt({ ...envelope, ciphertext: "a===" }))
      .rejects.toThrow("Memory encryption operation failed.");
  });

  it("rejects malformed key identifiers from the active provider", async () => {
    const provider: MemoryKeyProvider = {
      getActiveKey: async () => ({ keyId: "bad key id", key: randomBytes(32) }),
      getKey: async () => null
    };
    const cipher = new MemoryValueCipher(provider);
    await expect(cipher.encrypt("must-not-encrypt")).rejects.toThrow("Memory encryption operation failed.");
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

  it("rotates a bounded batch to the active key and preserves record metadata", async () => {
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    let active = { keyId: "test-key-v1", key: oldKey };
    const provider: MemoryKeyProvider = {
      getActiveKey: async () => active,
      getKey: async (id) => id === "test-key-v1" ? oldKey : id === "test-key-v2" ? newKey : null
    };
    const cipher = new MemoryValueCipher(provider);
    const rotationContext = { tenantId: "tenant-a", namespace: "tenant-a/notes", key: "k" };
    const original = await cipher.encrypt('{"classification":"confidential","value":"rotate-me"}', rotationContext);
    const createdAt = "2026-01-01T00:00:00.000Z";
    const expiresAt = "2026-04-01T00:00:00.000Z";
    const stored = { ...original, schemaVersion: 1 as const, createdAt, updatedAt: createdAt,
      expiresAt, classification: "confidential" as const };
    active = { keyId: "test-key-v2", key: newKey };
    let updateValues: readonly unknown[] = [];
    const db: SqlExecutor = {
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        if (sql.startsWith("SELECT")) {
          return { rows: [{ tenant_id: "tenant-a", namespace: "tenant-a/notes",
            memory_key: "k", envelope: stored }] };
        }
        if (sql.startsWith("UPDATE")) {
          updateValues = values;
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      })
    };
    const store = new PostgresEncryptedMemoryStore(db, cipher);
    await expect(store.reencryptBatch(10)).resolves.toEqual({ examined: 1, rotated: 1 });
    const replacement = JSON.parse(String(updateValues[0])) as typeof stored;
    expect(replacement.keyId).toBe("test-key-v2");
    expect(replacement.createdAt).toBe(createdAt);
    expect(replacement.expiresAt).toBe(expiresAt);
    expect(replacement.classification).toBe("confidential");
    expect(await cipher.decrypt(replacement, rotationContext)).toBe('{"classification":"confidential","value":"rotate-me"}');
    expect(JSON.stringify(replacement)).not.toContain("rotate-me");
    expect(updateValues.slice(2, 5)).toEqual(["tenant-a", "tenant-a/notes", "k"]);
  });

  it("upgrades a v1 envelope to v2 even when its key id is already active", async () => {
    const key = randomBytes(32);
    const provider: MemoryKeyProvider = {
      getActiveKey: async () => ({ keyId: "test-key-v1", key }),
      getKey: async (id) => id === "test-key-v1" ? key : null
    };
    const cipher = new MemoryValueCipher(provider);
    const legacy = await cipher.encrypt('{"classification":"internal","value":"legacy"}');
    expect(legacy.formatVersion).toBe(1);
    const stored = {
      ...legacy, schemaVersion: 1 as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-04-01T00:00:00.000Z",
      classification: "internal" as const
    };
    let replacement: Record<string, unknown> | undefined;
    let selectSql = "";
    const db: SqlExecutor = {
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        if (sql.startsWith("SELECT")) {
          selectSql = sql;
          expect(values).toEqual(["test-key-v1", 10]);
          return { rows: [{ tenant_id: "tenant-a", namespace: "tenant-a/notes",
            memory_key: "k", envelope: stored }] };
        }
        if (sql.startsWith("UPDATE")) {
          replacement = JSON.parse(String(values[0])) as Record<string, unknown>;
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      })
    };
    const store = new PostgresEncryptedMemoryStore(db, cipher);
    await expect(store.reencryptBatch(10)).resolves.toEqual({ examined: 1, rotated: 1 });
    expect(selectSql).toContain("envelope->>'formatVersion' IS DISTINCT FROM '2'");
    expect(replacement?.formatVersion).toBe(2);
    expect(await cipher.decrypt(replacement as never, {
      tenantId: "tenant-a", namespace: "tenant-a/notes", key: "k"
    })).toBe('{"classification":"internal","value":"legacy"}');
  });

  it("does not count a concurrently changed record as rotated", async () => {
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    let active = { keyId: "test-key-v1", key: oldKey };
    const provider: MemoryKeyProvider = {
      getActiveKey: async () => active,
      getKey: async (id) => id === "test-key-v1" ? oldKey : id === "test-key-v2" ? newKey : null
    };
    const cipher = new MemoryValueCipher(provider);
    const original = await cipher.encrypt('{"classification":"internal","value":"concurrent"}', { tenantId: "tenant-a", namespace: "tenant-a/notes", key: "k" });
    const stored = { ...original, schemaVersion: 1 as const, createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-04-01T00:00:00.000Z",
      classification: "internal" as const };
    active = { keyId: "test-key-v2", key: newKey };
    const db: SqlExecutor = {
      query: vi.fn(async (sql: string) => {
        if (sql.startsWith("SELECT")) return { rows: [{ tenant_id: "tenant-a",
          namespace: "tenant-a/notes", memory_key: "k", envelope: stored }] };
        return { rows: [], rowCount: 0 };
      })
    };
    const store = new PostgresEncryptedMemoryStore(db, cipher);
    await expect(store.reencryptBatch(1)).resolves.toEqual({ examined: 1, rotated: 0 });
  });

});
