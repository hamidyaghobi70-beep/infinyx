import type { TenantPrincipal } from "./tenant-transaction.js";
import {
  requireTenantRole,
  TENANT_ROLES,
  type TenantMembership
} from "./tenant-membership.js";
import type { TenantTransaction } from "./tenant-transaction.js";

export interface TenantRecord {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

/**
 * Reads the current tenant only after resolving a persisted membership.
 * Call this inside the same tenant transaction as any operation it authorizes.
 */
export async function getCurrentTenant(
  transaction: TenantTransaction,
  principal: TenantPrincipal
): Promise<{ tenant: TenantRecord; membership: TenantMembership } | null> {
  const membership = await requireTenantRole(
    transaction,
    principal,
    TENANT_ROLES
  );

  const rows = await transaction.query<{
    id: string;
    name: string;
    created_at: string;
  }>(
    "SELECT id, name, created_at::text AS created_at FROM tenants WHERE id = $1 LIMIT 1",
    [principal.tenantId]
  );

  const row = rows[0];
  if (!row) return null;

  return Object.freeze({
    tenant: Object.freeze({
      id: row.id,
      name: row.name,
      createdAt: row.created_at
    }),
    membership
  });
}
