import type { AuthenticatedPrincipal } from "../core/authenticated-principal.js";
import {
  withTenantTransaction,
  type TenantSqlPool
} from "./tenant-transaction.js";

export const TENANT_ROLES = [
  "owner",
  "admin",
  "manager",
  "editor",
  "viewer"
] as const;

export type TenantRole = (typeof TENANT_ROLES)[number];

export interface TenantMembership {
  readonly tenantId: string;
  readonly userId: string;
  readonly role: TenantRole;
}

export class TenantAuthorizationError extends Error {
  constructor() {
    super("Tenant authorization failed.");
    this.name = "TenantAuthorizationError";
  }
}

function isTenantRole(value: unknown): value is TenantRole {
  return typeof value === "string" &&
    (TENANT_ROLES as readonly string[]).includes(value);
}

/** A JWT tenant claim alone is not membership: resolve it from the database. */
export async function getTenantMembership(
  pool: TenantSqlPool,
  principal: AuthenticatedPrincipal
): Promise<TenantMembership | null> {
  const rows = await withTenantTransaction(pool, principal, (transaction) =>
    transaction.query<{ role: string }>(
      "SELECT role FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2 LIMIT 1",
      [principal.tenantId, principal.subject]
    )
  );

  const role = rows[0]?.role;
  if (!isTenantRole(role)) return null;

  return Object.freeze({
    tenantId: principal.tenantId,
    userId: principal.subject,
    role
  });
}

/** Requires a database membership and an explicitly allowed role. */
export async function requireTenantRole(
  pool: TenantSqlPool,
  principal: AuthenticatedPrincipal,
  allowedRoles: readonly TenantRole[]
): Promise<TenantMembership> {
  const membership = await getTenantMembership(pool, principal);
  if (!membership || !allowedRoles.includes(membership.role)) {
    throw new TenantAuthorizationError();
  }
  return membership;
}
