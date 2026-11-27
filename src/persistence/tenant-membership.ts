import type { TenantPrincipal, TenantTransaction } from "./tenant-transaction.js";
import { isTenantPrincipal, TenantAuthorizationError } from "./tenant-transaction.js";

export { TenantAuthorizationError } from "./tenant-transaction.js";

export const TENANT_ROLES = [
  "owner",
  "admin",
  "manager",
  "editor",
  "viewer"
] as const;

export type TenantRole = (typeof TENANT_ROLES)[number];

export interface TenantMembership {
  readonly membershipId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly generation: number;
  readonly role: TenantRole;
  readonly status: "active";
  readonly version: string;
}

function isTenantRole(value: unknown): value is TenantRole {
  return typeof value === "string" &&
    (TENANT_ROLES as readonly string[]).includes(value);
}

/** Resolve the current active membership by INFINYX internal user ID. */
export async function getTenantMembership(
  transaction: TenantTransaction,
  principal: TenantPrincipal
): Promise<TenantMembership | null> {
  if (!isTenantPrincipal(principal)) throw new TenantAuthorizationError();

  const rows = await transaction.query<{
    membership_id: string;
    generation: number;
    role: string;
    status: string;
    version: string | number;
  }>(
    `SELECT membership_id::text AS membership_id, generation, role, status, version
       FROM tenant_memberships
      WHERE tenant_id = $1
        AND internal_user_id = $2::uuid
        AND status = 'active'
      ORDER BY generation DESC
      LIMIT 1`,
    [principal.tenantId, principal.userId]
  );

  const row = rows[0];
  if (!row || row.status !== "active" || !isTenantRole(row.role)) return null;

  return Object.freeze({
    membershipId: row.membership_id,
    tenantId: principal.tenantId,
    userId: principal.userId,
    generation: row.generation,
    role: row.role,
    status: "active",
    version: String(row.version)
  });
}

/** Requires a current active database membership and an explicitly allowed role. */
export async function requireTenantRole(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  allowedRoles: readonly TenantRole[]
): Promise<TenantMembership> {
  const membership = await getTenantMembership(transaction, principal);
  if (!membership || !allowedRoles.includes(membership.role)) {
    throw new TenantAuthorizationError();
  }
  return membership;
}
