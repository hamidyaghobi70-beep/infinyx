import { describe, expect, it } from "vitest";
import { createTestPrincipal } from "../core/testing/test-principal.js";
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
async function principal() {
  return createTestPrincipal({
    issuer, audience, subject: "provider-subject", userId
  });
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
    const identity = await principal();
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
    const identity = await principal();
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
    const identity = await principal();
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
    const identity = await principal();
    await expect(withTenantTransaction(
      poolWithMembership("unexpected"), identity, "tenant-1",
      (transaction) => getTenantMembership(transaction, identity)
    )).rejects.toBeInstanceOf(TenantAuthorizationError);
  });
});
