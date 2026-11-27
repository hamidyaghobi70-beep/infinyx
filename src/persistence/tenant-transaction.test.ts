import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  AuthenticationError,
  createAuthenticatedPrincipalResolver,
  createJwtPrincipalVerifier,
  type AuthenticatedPrincipal
} from "../core/authenticated-principal.js";
import {
  TenantPersistenceError,
  createTenantMemoryScope,
  withTenantTransaction,
  type SqlQueryResult,
  type TenantSqlClient,
  type TenantSqlPool,
  type TenantTransaction
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
const principal = createAuthenticatedPrincipalResolver(
  () => "10000000-0000-4000-8000-000000000001"
)(verify(
  signingInput + "." + sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url")
));

function fakeDatabase() {
  const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
  let releaseCount = 0;
  const failures = new Set<string>();
  const destroyedClients: boolean[] = [];
  const client: TenantSqlClient = {
    async query<Row>(sql: string, values?: readonly unknown[]): Promise<SqlQueryResult<Row>> {
      calls.push({ sql, values });
      if (failures.has(sql)) throw new Error("sensitive database detail");
      if (sql.includes("FROM tenant_memberships")) {
        return { rows: [{
          membership_id: "00000000-0000-4000-8000-000000000010",
          role: "owner", generation: 1, version: "1"
        } as Row], rowCount: 1 };
      }
      return { rows: [{ value: "ok" } as Row], rowCount: 1 };
    },
    release(destroy?: boolean) {
      releaseCount += 1;
      destroyedClients.push(destroy === true);
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
    setFailure(sql: string) { failures.add(sql); },
    destroyedClients,
    get releaseCount() { return releaseCount; }
  };
}

describe("withTenantTransaction", () => {
  it("creates tenant memory scope only from the active authorized transaction", async () => {
    const db = fakeDatabase();
    const scope = await withTenantTransaction(db.pool, principal, "tenant-a", (tx) =>
      createTenantMemoryScope(tx, principal, "assistant")
    );
    expect(scope).toEqual({
      scope: "tenant",
      tenantId: "tenant-a",
      userId: principal.userId,
      membershipId: "00000000-0000-4000-8000-000000000010",
      moduleId: "assistant"
    });
  });

  it("binds the verified tenant in a transaction and commits before release", async () => {
    const db = fakeDatabase();
    const result = await withTenantTransaction(db.pool, principal, "tenant-a", async (tx) => {
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
      "SELECT membership_id::text AS membership_id, role, generation, version\n           FROM tenant_memberships\n          WHERE tenant_id = $1\n            AND internal_user_id = $2::uuid\n            AND status = 'active'\n          ORDER BY generation DESC\n          LIMIT 1\n          FOR SHARE",
      "SELECT value FROM tenant_records WHERE tenant_id = $1",
      "COMMIT"
    ]);
    expect(db.calls[1]?.values).toEqual(["tenant-a"]);
    expect(db.calls[2]?.values).toEqual(["tenant-a", principal.userId]);
    expect(db.releaseCount).toBe(1);
  });

  it("rejects use of a captured transaction after it has completed", async () => {
    const db = fakeDatabase();
    let captured: TenantTransaction | undefined;
    await withTenantTransaction(db.pool, principal, "tenant-a", async (tx) => {
      captured = tx;
      return "complete";
    });

    const callsBeforeReuse = db.calls.length;
    await expect(captured!.query("SELECT private_data"))
      .rejects.toBeInstanceOf(TenantPersistenceError);
    expect(db.calls).toHaveLength(callsBeforeReuse);
    expect(db.releaseCount).toBe(1);
  });

  it("rejects a forged principal before acquiring a database client", async () => {
    const db = fakeDatabase();
    const connect = vi.spyOn(db.pool, "connect");
    await expect(
      withTenantTransaction(db.pool, { ...principal } as AuthenticatedPrincipal, "tenant-a", async () => "no")
    ).rejects.toBeInstanceOf(AuthenticationError);
    expect(connect).not.toHaveBeenCalled();
    expect(db.calls).toHaveLength(0);
  });

  it("rolls back and releases when repository work fails", async () => {
    const db = fakeDatabase();
    await expect(
      withTenantTransaction(db.pool, principal, "tenant-a", async () => {
        throw new Error("domain failure");
      })
    ).rejects.toThrow("domain failure");
    expect(db.calls.map((call) => call.sql)).toEqual([
      "BEGIN",
      "SELECT set_config('app.tenant_id', $1, true)",
      "SELECT membership_id::text AS membership_id, role, generation, version\n           FROM tenant_memberships\n          WHERE tenant_id = $1\n            AND internal_user_id = $2::uuid\n            AND status = 'active'\n          ORDER BY generation DESC\n          LIMIT 1\n          FOR SHARE",
      "ROLLBACK"
    ]);
    expect(db.releaseCount).toBe(1);
  });

  it("sanitizes database query errors and rolls back", async () => {
    const db = fakeDatabase();
    db.setFailure("SELECT private_data");
    await expect(
      withTenantTransaction(db.pool, principal, "tenant-a", (tx) => tx.query("SELECT private_data"))
    ).rejects.toBeInstanceOf(TenantPersistenceError);
    expect(db.calls.map((call) => call.sql)).toEqual([
      "BEGIN",
      "SELECT set_config('app.tenant_id', $1, true)",
      "SELECT membership_id::text AS membership_id, role, generation, version\n           FROM tenant_memberships\n          WHERE tenant_id = $1\n            AND internal_user_id = $2::uuid\n            AND status = 'active'\n          ORDER BY generation DESC\n          LIMIT 1\n          FOR SHARE",
      "SELECT private_data",
      "ROLLBACK"
    ]);
    expect(db.releaseCount).toBe(1);
  });


  it("rolls back if repository code catches a failed query", async () => {
    const db = fakeDatabase();
    db.setFailure("SELECT private_data");
    await expect(
      withTenantTransaction(db.pool, principal, "tenant-a", async (tx) => {
        try {
          await tx.query("SELECT private_data");
        } catch {
          // A repository must not be able to swallow a database failure.
        }
        return "incorrect success";
      })
    ).rejects.toBeInstanceOf(TenantPersistenceError);
    expect(db.calls.map((call) => call.sql)).toEqual([
      "BEGIN",
      "SELECT set_config('app.tenant_id', $1, true)",
      "SELECT membership_id::text AS membership_id, role, generation, version\n           FROM tenant_memberships\n          WHERE tenant_id = $1\n            AND internal_user_id = $2::uuid\n            AND status = 'active'\n          ORDER BY generation DESC\n          LIMIT 1\n          FOR SHARE",
      "SELECT private_data",
      "ROLLBACK"
    ]);
    expect(db.releaseCount).toBe(1);
    expect(db.destroyedClients).toEqual([false]);
  });

  it("destroys the pooled client if rollback fails", async () => {
    const db = fakeDatabase();
    db.setFailure("ROLLBACK");
    await expect(
      withTenantTransaction(db.pool, principal, "tenant-a", async () => {
        throw new Error("repository failure");
      })
    ).rejects.toThrow("repository failure");
    expect(db.releaseCount).toBe(1);
    expect(db.destroyedClients).toEqual([true]);
  });

  it("releases the client if tenant context setup fails", async () => {
    const db = fakeDatabase();
    db.setFailure("SELECT set_config('app.tenant_id', $1, true)");
    await expect(
      withTenantTransaction(db.pool, principal, "tenant-a", async () => "not reached")
    ).rejects.toBeInstanceOf(TenantPersistenceError);
    expect(db.calls.map((call) => call.sql)).toEqual([
      "BEGIN",
      "SELECT set_config('app.tenant_id', $1, true)",
      "ROLLBACK"
    ]);
    expect(db.releaseCount).toBe(1);
  });
});
