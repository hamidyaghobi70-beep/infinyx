import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createAuthenticatedPrincipalResolver,
  createJwtPrincipalVerifier
} from "../core/authenticated-principal.js";
import {
  getTenantMembership,
  requireTenantRole,
  TenantAuthorizationError
} from "./tenant-membership.js";
import {
  withTenantTransaction,
  type SqlQueryResult,
  type TenantSqlClient,
  type TenantSqlPool
} from "./tenant-transaction.js";

const issuer = "https://infinyx.membership.test";
const audience = "infinyx-membership-test";
const userId = "10000000-0000-4000-8000-000000000001";
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const verifier = createJwtPrincipalVerifier({
  issuer,
  audience,
  publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString()
});
const resolver = createAuthenticatedPrincipalResolver(() => userId);

function principal() {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = [
    encode({ alg: "RS256", typ: "JWT" }),
    encode({ iss: issuer, aud: audience, sub: "provider-subject", exp: Math.floor(Date.now() / 1000) + 60 })
  ].join(".");
  const signature = sign("RSA-SHA256", Buffer.from(unsigned, "ascii"), keys.privateKey).toString("base64url");
  return resolver(verifier(`${unsigned}.${signature}`));
}

function poolWithMembership(role: string | null, status = "active"): TenantSqlPool {
  const client: TenantSqlClient = {
    async query<Row = Record<string, unknown>>(
      sql: string,
      _values?: readonly unknown[]
    ): Promise<SqlQueryResult<Row>> {
      if (sql.includes("FROM tenant_memberships") && role && status === "active") {
        return {
          rows: [{
            membership_id: "00000000-0000-4000-8000-000000000001",
            role,
            status,
            generation: 1,
            version: "1"
          } as Row],
          rowCount: 1
        };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {}
  };
  return { async connect() { return client; } };
}

describe("tenant membership authorization", () => {
  it("resolves the active membership using the stable internal user ID", async () => {
    const identity = principal();
    const membership = await withTenantTransaction(
      poolWithMembership("manager"), identity, "tenant-1",
      (transaction) => getTenantMembership(transaction, identity)
    );
    expect(membership).toEqual({
      membershipId: "00000000-0000-4000-8000-000000000001",
      tenantId: "tenant-1",
      userId,
      generation: 1,
      role: "manager",
      status: "active",
      version: "1"
    });
  });

  it("denies missing, suspended and removed memberships before callback execution", async () => {
    const identity = principal();
    let callbackCalled = false;
    await expect(withTenantTransaction(
      poolWithMembership(null), identity, "tenant-1",
      async () => { callbackCalled = true; }
    )).rejects.toBeInstanceOf(TenantAuthorizationError);
    await expect(withTenantTransaction(
      poolWithMembership("manager", "suspended"), identity, "tenant-1",
      async () => { callbackCalled = true; }
    )).rejects.toBeInstanceOf(TenantAuthorizationError);
    await expect(withTenantTransaction(
      poolWithMembership("manager", "removed"), identity, "tenant-1",
      async () => { callbackCalled = true; }
    )).rejects.toBeInstanceOf(TenantAuthorizationError);
    expect(callbackCalled).toBe(false);
  });

  it("allows only explicitly permitted roles", async () => {
    const identity = principal();
    await expect(withTenantTransaction(
      poolWithMembership("editor"), identity, "tenant-1",
      (transaction) => requireTenantRole(transaction, identity, ["owner", "admin", "editor"])
    )).resolves.toMatchObject({ role: "editor" });
    await expect(withTenantTransaction(
      poolWithMembership("viewer"), identity, "tenant-1",
      (transaction) => requireTenantRole(transaction, identity, ["owner", "admin", "editor"])
    )).rejects.toBeInstanceOf(TenantAuthorizationError);
  });

  it("fails closed for unknown database roles", async () => {
    const identity = principal();
    await expect(withTenantTransaction(
      poolWithMembership("unexpected"), identity, "tenant-1",
      (transaction) => getTenantMembership(transaction, identity)
    )).rejects.toBeInstanceOf(TenantAuthorizationError);
  });
});
