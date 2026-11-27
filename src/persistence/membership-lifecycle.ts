import type { TenantPrincipal } from "./tenant-transaction.js";
import type { TenantTransaction } from "./tenant-transaction.js";
import {
  TenantAuthorizationError,
  TENANT_ROLES,
  type TenantRole
} from "./tenant-membership.js";

export type MembershipStatus = "active" | "suspended" | "removed";
export type MembershipLifecycleOutcome = "succeeded" | "denied" | "noop";
export type MembershipLifecycleTargetStatus = Exclude<MembershipStatus, "removed"> | "removed";

export interface MembershipLifecycleResult {
  readonly outcome: MembershipLifecycleOutcome;
}

interface MembershipRow {
  membership_id: string;
  user_id: string;
  role: string;
  status: string;
  generation: number;
  version: string | number;
}

interface ExistingAuditRow {
  actor_user_id: string;
  target_user_id: string;
  requested_status: string;
  outcome: MembershipLifecycleOutcome;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class MembershipLifecycleInputError extends Error {
  constructor() {
    super("Invalid membership lifecycle request.");
    this.name = "MembershipLifecycleInputError";
  }
}

export class MembershipLifecycleIdempotencyConflictError extends Error {
  constructor() {
    super("Membership lifecycle request conflict.");
    this.name = "MembershipLifecycleIdempotencyConflictError";
  }
}

function isTenantRole(value: string): value is TenantRole {
  return (TENANT_ROLES as readonly string[]).includes(value);
}

function isMembershipStatus(value: string): value is MembershipStatus {
  return value === "active" || value === "suspended" || value === "removed";
}

async function writeAudit(
  transaction: TenantTransaction,
  input: {
    tenantId: string;
    actorUserId: string;
    targetUserId: string;
    targetMembershipId: string | null;
    requestedStatus: MembershipLifecycleTargetStatus;
    previousStatus: MembershipStatus | null;
    outcome: MembershipLifecycleOutcome;
    reasonCode: string;
    correlationId: string;
  }
): Promise<void> {
  await transaction.query(
    `INSERT INTO tenant_membership_audit_events
      (tenant_id, actor_user_id, target_user_id, target_membership_id,
       requested_status, previous_status, outcome, reason_code, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.tenantId,
      input.actorUserId,
      input.targetUserId,
      input.targetMembershipId,
      input.requestedStatus,
      input.previousStatus,
      input.outcome,
      input.reasonCode,
      input.correlationId
    ]
  );
}

/**
 * Performs one tenant-scoped membership transition and its audit write atomically.
 * The caller must execute this inside withTenantTransaction using a verified principal.
 * Owner targets are deliberately excluded; ownership governance is a separate workflow.
 */
export async function transitionTenantMembership(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  targetUserId: string,
  requestedStatus: MembershipLifecycleTargetStatus,
  correlationId: string
): Promise<MembershipLifecycleResult> {
  if (
    typeof targetUserId !== "string" ||
    !UUID_PATTERN.test(targetUserId) ||
    !isMembershipStatus(requestedStatus) ||
    !UUID_PATTERN.test(correlationId)
  ) {
    throw new MembershipLifecycleInputError();
  }

  const tenantRows = await transaction.query<{ id: string }>(
    "SELECT id FROM tenants WHERE id = $1 FOR UPDATE",
    [principal.tenantId]
  );
  if (tenantRows.length === 0) throw new TenantAuthorizationError();

  const priorEvents = await transaction.query<ExistingAuditRow>(
    `SELECT actor_user_id, target_user_id, requested_status, outcome
       FROM tenant_membership_audit_events
      WHERE tenant_id = $1 AND correlation_id = $2
      LIMIT 1`,
    [principal.tenantId, correlationId]
  );
  const prior = priorEvents[0];
  if (prior) {
    if (
      prior.actor_user_id !== principal.userId ||
      prior.target_user_id !== targetUserId ||
      prior.requested_status !== requestedStatus
    ) {
      throw new MembershipLifecycleIdempotencyConflictError();
    }
    return Object.freeze({ outcome: prior.outcome });
  }

  const memberRows = await transaction.query<MembershipRow>(
    `SELECT membership_id::text AS membership_id, internal_user_id::text AS user_id,
            role, status, generation, version
       FROM tenant_memberships
      WHERE tenant_id = $1
        AND internal_user_id = ANY($2::uuid[])
        AND generation = (
          SELECT max(latest.generation)
            FROM tenant_memberships AS latest
           WHERE latest.tenant_id = tenant_memberships.tenant_id
             AND latest.internal_user_id = tenant_memberships.internal_user_id
        )
      ORDER BY user_id
      FOR UPDATE`,
    [principal.tenantId, [principal.userId, targetUserId]]
  );
  const actor = memberRows.find((row) => row.user_id === principal.userId);
  const target = memberRows.find((row) => row.user_id === targetUserId);

  let reasonCode = "";
  let outcome: MembershipLifecycleOutcome = "denied";
  let previousStatus: MembershipStatus | null =
    target && isMembershipStatus(target.status) ? target.status : null;

  if (!actor || actor.status !== "active" || !isTenantRole(actor.role) ||
      (actor.role !== "owner" && actor.role !== "admin")) {
    reasonCode = "actor_not_authorized";
  } else if (targetUserId === principal.userId) {
    reasonCode = "self_lifecycle_forbidden";
  } else if (!target || !isTenantRole(target.role) ||
      !isMembershipStatus(target.status)) {
    reasonCode = "target_not_found";
  } else if (target.role === "owner") {
    reasonCode = "owner_governance_required";
  } else if (target.status === requestedStatus) {
    outcome = "noop";
    reasonCode = "same_state";
  } else if (target.status === "removed") {
    reasonCode = "removed_membership_terminal";
  } else {
    outcome = "succeeded";
    reasonCode = "transition_applied";
  }

  if (outcome === "succeeded" && target) {
    const updated = await transaction.query<{ membership_id: string }>(
      `UPDATE tenant_memberships
          SET status = $1,
              status_changed_at = now(),
              status_changed_by = $2,
              status_change_correlation_id = $3,
              version = version + 1
        WHERE tenant_id = $4
          AND membership_id = $5
          AND status = $6
          AND version = $7
        RETURNING membership_id::text AS membership_id`,
      [
        requestedStatus,
        principal.userId,
        correlationId,
        principal.tenantId,
        target.membership_id,
        target.status,
        target.version
      ]
    );
    if (updated.length !== 1) {
      outcome = "denied";
      reasonCode = "concurrent_state_change";
    }
  }

  await writeAudit(transaction, {
    tenantId: principal.tenantId,
    actorUserId: principal.userId,
    targetUserId,
    targetMembershipId: target?.membership_id ?? null,
    requestedStatus,
    previousStatus,
    outcome,
    reasonCode,
    correlationId
  });

  return Object.freeze({ outcome });
}
