import { describe, expect, it } from "vitest";
import type { AuthenticatedPrincipal } from "../core/authenticated-principal.js";
import { getCurrentTenant } from "./tenant-repository.js";
import type { TenantTransaction } from "./tenant-transaction.js";

const principal = {
  subject: "user-1",
  tenantId: "tenant-1"
} as AuthenticatedPrincipal;

function transaction(options: {
  role?: string | null;
  tenant?: { id: string; name: string; created_at: string } | null;
  calls?: Array<{ sql: string; values: readonly unknown[] }>;
} = {}): TenantTransaction {
  return {
    query: async <Row = Record<string, unknown>>(
      sql: string,
      values: readonly unknown[] = []
    ): Promise<readonly Row[]> => {
      options.calls?.push({ sql, values });
      if (sql.startsWith("SELECT membership_id::text AS membership_id")) {
        return (options.role ? [{
          membership_id: "00000000-0000-4000-8000-000000000001",
          generation: 1,
          role: options.role,
          status: "active",
          version: 1
        }] : []) as unknown as readonly Row[];
      }
      if (sql.startsWith("SELECT id, name, created_at::text")) {
        return (options.tenant ? [options.tenant] : []) as unknown as readonly Row[];
      }
      throw new Error("Unexpected query");
    }
  };
}

describe("tenant repository", () => {
  it("returns the current tenant and its persisted membership", async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const result = await getCurrentTenant(transaction({
      role: "owner",
      tenant: {
        id: "tenant-1",
        name: "Example Business",
        created_at: "2026-11-27 00:00:00+00"
      },
      calls
    }), principal);

    expect(result).toEqual({
      tenant: {
        id: "tenant-1",
        name: "Example Business",
        createdAt: "2026-11-27 00:00:00+00"
      },
      membership: {
        membershipId: "00000000-0000-4000-8000-000000000001",
        tenantId: "tenant-1",
        userId: "user-1",
        generation: 1,
        role: "owner",
        status: "active",
        version: 1
      }
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.values).toEqual(["tenant-1"]);
  });

  it("does not query tenant data when membership is absent", async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    await expect(getCurrentTenant(transaction({ role: null, calls }), principal))
      .rejects.toThrow("Tenant authorization failed.");
    expect(calls).toHaveLength(1);
  });

  it("returns null when the tenant row is not visible", async () => {
    await expect(getCurrentTenant(transaction({ role: "viewer", tenant: null }), principal))
      .resolves.toBeNull();
  });
});
