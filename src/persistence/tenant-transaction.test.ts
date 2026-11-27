import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  AuthenticationError,
  createJwtPrincipalVerifier,
  type AuthenticatedPrincipal
} from "../core/authenticated-principal.js";
import {
  TenantPersistenceError,
  withTenantTransaction,
  type SqlQueryResult,
  type TenantSqlClient,
  type TenantSqlPool
} from "./tenant-transaction.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" }
});
const now = 1_800_000_000;
const verify = createJwtPrincipalVerifier({
  issuer: "https://identity.infinyx.test",
  audience: "infinyx-api",
  publicKeyPem: publicKey,
  now: () => now
});
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const header = encode({ alg: "RS256", typ: "JWT" });
const payload = encode({
  iss: "https://identity.infinyx.test",
  aud: "infinyx-api",
  sub: "user-a",
  tenant_id: "tenant-a",
  exp: now + 300
});
const signingInput = header + "." + payload;
const principal = verify(
  signingInput + "." + sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url")
);

function fakeDatabase() {
  const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
  let releaseCount = 0;
  let failOn: string | undefined;
  const client: TenantSqlClient = {
    async query<Row>(sql: string, values?: readonly unknown[]): Promise<SqlQueryResult<Row>> {
      calls.push({ sql, values });
      if (sql === failOn) throw new Error("sensitive database detail");
      return { rows: [{ value: "ok" } as Row], rowCount: 1 };
    },
    release() {
      releaseCount += 1;
    }
  };
  const pool: TenantSqlPool = {
    async connect() {
      return client;
    }
  };
  return {
    calls,
    pool,
    client,
    setFailure(sql: string) { failOn = sql; },
    get releaseCount() { return releaseCount; }
  };
}

describe("withTenantTransaction", () => {
  it("binds the verified tenant in a transaction and commits before release", async () => {
    const db = fakeDatabase();
    const result = await withTenantTransaction(db.pool, principal, async (tx) => {
      const rows = await tx.query<{ value: string }>(
        "SELECT value FROM tenant_records WHERE tenant_id = $1",
        ["tenant-a"]
      );
      return rows[0]?.value;
    });

    expect(result).toBe("ok");
    expect(db.calls.map((call) => call.sql)).toEqual([
      "BEGIN",
      "SELECT set_config('app.tenant_id', $1, true)",
      "SELECT value FROM tenant_records WHERE tenant_id = $1",
      "COMMIT"
    ]);
    expect(db.calls[1]?.values).toEqual(["tenant-a"]);
    expect(db.releaseCount).toBe(1);
  });

  it("rejects a forged principal before acquiring a database client", async () => {
    const db = fakeDatabase();
    const connect = vi.spyOn(db.pool, "connect");
    await expect(
      withTenantTransaction(db.pool, { ...principal } as AuthenticatedPrincipal, async () => "no")
    ).rejects.toBeInstanceOf(AuthenticationError);
    expect(connect).not.toHaveBeenCalled();
    expect(db.calls).toHaveLength(0);
  });

  it("rolls back and releases when repository work fails", async () => {
    const db = fakeDatabase();
    await expect(
      withTenantTransaction(db.pool, principal, async () => {
        throw new Error("domain failure");
      })
    ).rejects.toThrow("domain failure");
    expect(db.calls.map((call) => call.sql)).toEqual([
      "BEGIN",
      "SELECT set_config('app.tenant_id', $1, true)",
      "ROLLBACK"
    ]);
    expect(db.releaseCount).toBe(1);
  });

  it("sanitizes database query errors and rolls back", async () => {
    const db = fakeDatabase();
    db.setFailure("SELECT private_data");
    await expect(
      withTenantTransaction(db.pool, principal, (tx) => tx.query("SELECT private_data"))
    ).rejects.toBeInstanceOf(TenantPersistenceError);
    expect(db.calls.map((call) => call.sql)).toEqual([
      "BEGIN",
      "SELECT set_config('app.tenant_id', $1, true)",
      "SELECT private_data",
      "ROLLBACK"
    ]);
    expect(db.releaseCount).toBe(1);
  });

  it("releases the client if tenant context setup fails", async () => {
    const db = fakeDatabase();
    db.setFailure("SELECT set_config('app.tenant_id', $1, true)");
    await expect(
      withTenantTransaction(db.pool, principal, async () => "not reached")
    ).rejects.toBeInstanceOf(TenantPersistenceError);
    expect(db.calls.map((call) => call.sql)).toEqual([
      "BEGIN",
      "SELECT set_config('app.tenant_id', $1, true)",
      "ROLLBACK"
    ]);
    expect(db.releaseCount).toBe(1);
  });
});
