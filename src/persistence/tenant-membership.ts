import type { AuthenticatedPrincipal } from "../core/authenticated-principal.js";
import {
  getTenantTransactionContext,
  TenantAuthorizationError,
  type TenantTransaction
} from "./tenant-transaction.js";

export { TenantAuthorizationError } from "./tenant-transaction.js";

export const TENANT_ROLES = ["owner", "admin", "manager", "editor", "viewer"] as const;
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
  return typeof value === "string" && (TENANT_ROLES as readonly string[]).includes(value);
}

/** Resolve the active membership for the internal user in this authorized transaction. */
export async function getTenantMembership(
  transaction: TenantTransaction,
  principal: AuthenticatedPrincipal
): Promise<TenantMembership | null> {
  const context = getTenantTransactionContext(transaction, principal);
  const rows = await transaction.query<{
    membership_id: string;
    generation: number;
    role: string;
    status: string;
    version: string | number;
  }>(
    `SELECT membership_id::text AS membership_id, generation, role, status, version
       FROM tenant_memberships
      WHERE tenant_id = $1 AND internal_user_id = $2::uuid AND status = 'active'
      ORDER BY generation DESC LIMIT 1`,
    [context.tenantId, context.userId]
  );
  const row = rows[0];
  if (!row || row.status !== "active" || !isTenantRole(row.role)) return null;
  return Object.freeze({
    membershipId: row.membership_id,
    tenantId: context.tenantId,
    userId: context.userId,
    generation: row.generation,
    role: row.role,
    status: "active",
    version: String(row.version)
  });
}

export async function requireTenantRole(
  transaction: TenantTransaction,
  principal: AuthenticatedPrincipal,
  allowedRoles: readonly TenantRole[]
): Promise<TenantMembership> {
  const membership = await getTenantMembership(transaction, principal);
  if (!membership || !allowedRoles.includes(membership.role)) {
    throw new TenantAuthorizationError();
  }
  return membership;
}
