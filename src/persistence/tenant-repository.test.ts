import { describe, expect, it } from "vitest";
import { createTestPrincipal } from "../core/testing/test-principal.js";
import { getCurrentTenant } from "./tenant-repository.js";
import {
  TenantAuthorizationError,
  withTenantTransaction,
  type SqlQueryResult,
  type TenantSqlClient,
  type TenantSqlPool
} from "./tenant-transaction.js";

const issuer = "https://infinyx.tenant-repository.test";
const audience = "infinyx-test";
const userId = "10000000-0000-4000-8000-000000000001";
const principal = await createTestPrincipal({
  issuer, audience, subject: "provider-subject", userId
});

function pool(options: {
  role?: string | null;
  tenant?: { id: string; name: string; created_at: string } | null;
  calls?: Array<{ sql: string; values?: readonly unknown[] }>;
} = {}): TenantSqlPool {
  const client: TenantSqlClient = {
    async query<Row = Record<string, unknown>>(
      sql: string,
      values?: readonly unknown[]
    ): Promise<SqlQueryResult<Row>> {
      options.calls?.push({ sql, values });
      if (sql.includes("FROM tenant_memberships") && options.role) {
        return { rows: [{
          membership_id: "00000000-0000-4000-8000-000000000001",
          role: options.role, generation: 1, version: "1", status: "active"
        } as Row], rowCount: 1 };
      }
      if (sql.startsWith("SELECT id, name, created_at::text") && options.tenant) {
        return { rows: [options.tenant as Row], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {}
  };
  return { async connect() { return client; } };
}

describe("tenant repository", () => {
  it("returns the tenant only after transaction-bound membership authorization", async () => {
    const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
    const result = await withTenantTransaction(
      pool({
        role: "owner",
        tenant: {
          id: "tenant-1",
          name: "Example Business",
          created_at: "2026-11-27 00:00:00+00"
        },
        calls
      }),
      principal,
      "tenant-1",
      (transaction) => getCurrentTenant(transaction, principal)
    );

    expect(result).toEqual({
      tenant: { id: "tenant-1", name: "Example Business", createdAt: "2026-11-27 00:00:00+00" },
      membership: {
        membershipId: "00000000-0000-4000-8000-000000000001",
        tenantId: "tenant-1",
        userId,
        generation: 1,
        role: "owner",
        status: "active",
        version: "1"
      }
    });
    expect(calls.some((call) => call.sql.startsWith("SELECT id, name, created_at::text"))).toBe(true);
  });

  it("does not execute repository work when membership is absent", async () => {
    let callbackCalled = false;
    await expect(withTenantTransaction(
      pool({ role: null }), principal, "tenant-1",
      async () => { callbackCalled = true; return null; }
    )).rejects.toBeInstanceOf(TenantAuthorizationError);
    expect(callbackCalled).toBe(false);
  });

  it("returns null when the tenant row is not visible", async () => {
    await expect(withTenantTransaction(
      pool({ role: "viewer", tenant: null }), principal, "tenant-1",
      (transaction) => getCurrentTenant(transaction, principal)
    )).resolves.toBeNull();
  });
});
