import { randomUUID } from "node:crypto";
import type { AuthenticatedPrincipal } from "../core/authenticated-principal.js";
import {
  createInvitationSecrets,
  encryptInvitationDelivery,
  normalizeInvitationIdentity,
  type InvitationIdentityType,
  type InvitationKeyMaterial
} from "./tenant-invitation-crypto.js";
import { requireTenantRole, TenantAuthorizationError } from "./tenant-membership.js";
import type { TenantTransaction } from "./tenant-transaction.js";

const resolvedTargets = new WeakSet<object>();
const INVITATION_ROLES = ["admin", "manager", "editor", "viewer"] as const;
export type InvitationRole = (typeof INVITATION_ROLES)[number];

export interface InvitationIdentityDirectory {
  /**
   * Must be implemented by the selected trusted identity provider.
   * Return the account subject only when the provider can authoritatively
   * resolve the exact normalized identity; return null only for a trusted
   * not-found result. Do not implement this with client-supplied data.
   */
  resolveAccountSubject(
    identityType: InvitationIdentityType,
    normalizedIdentity: string
  ): Promise<string | null>;
}

export interface ResolvedInvitationTarget {
  readonly identityType: InvitationIdentityType;
  readonly normalizedIdentity: string;
  readonly accountSubject: string | null;
}

export class InvitationIntegrationUnavailableError extends Error {
  constructor() {
    super("Invitation identity integration is unavailable.");
    this.name = "InvitationIntegrationUnavailableError";
  }
}

export class InvitationConflictError extends Error {
  constructor() {
    super("Invitation request cannot be completed.");
    this.name = "InvitationConflictError";
  }
}

export class InvitationAuthorizationError extends Error {
  constructor() {
    super("Invitation authorization failed.");
    this.name = "InvitationAuthorizationError";
  }
}

export class InvitationRequestError extends Error {
  constructor() {
    super("Invalid invitation request.");
    this.name = "InvitationRequestError";
  }
}

interface InvitationRow {
  invitation_id: string;
  status: string;
  expires_at: string;
  is_expired?: boolean;
  version: string | number;
}

interface AuditRow {
  action: string;
  outcome: "succeeded" | "denied" | "noop";
  invitation_id: string | null;
  actor_user_id: string | null;
}

function isInvitationRole(value: string): value is InvitationRole {
  return (INVITATION_ROLES as readonly string[]).includes(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/** Resolve outside the database transaction so provider I/O never holds tenant locks. */
export async function resolveInvitationTarget(
  identityType: InvitationIdentityType,
  identity: string,
  directory: InvitationIdentityDirectory | null
): Promise<ResolvedInvitationTarget> {
  if (!directory) throw new InvitationIntegrationUnavailableError();

  const normalizedIdentity = normalizeInvitationIdentity(identityType, identity);
  let accountSubject: string | null;
  try {
    accountSubject = await directory.resolveAccountSubject(identityType, normalizedIdentity);
  } catch {
    throw new InvitationIntegrationUnavailableError();
  }

  if (accountSubject !== null &&
      (typeof accountSubject !== "string" || accountSubject.length < 1 ||
       accountSubject.length > 256 || /[\u0000-\u001f\u007f-\u009f]/.test(accountSubject))) {
    throw new InvitationIntegrationUnavailableError();
  }

  const target = Object.freeze({ identityType, normalizedIdentity, accountSubject });
  resolvedTargets.add(target);
  return target;
}

async function lockAndAuthorizeTenant(
  transaction: TenantTransaction,
  principal: AuthenticatedPrincipal
): Promise<void> {
  const tenant = await transaction.query<{ id: string }>(
    "SELECT id FROM tenants WHERE id = $1 FOR UPDATE",
    [principal.tenantId]
  );
  if (tenant.length !== 1) throw new TenantAuthorizationError();
  try {
    await requireTenantRole(transaction, principal, ["owner", "admin"]);
  } catch {
    throw new InvitationAuthorizationError();
  }
}

async function writeInvitationAudit(
  transaction: TenantTransaction,
  input: {
    tenantId: string;
    invitationId: string | null;
    actorUserId: string | null;
    action: "created" | "revoked" | "expired" | "replay_denied";
    previousStatus: string | null;
    newStatus: string | null;
    outcome: "succeeded" | "denied" | "noop";
    reasonCode: string;
    correlationId: string;
  }
): Promise<void> {
  await transaction.query(
    `INSERT INTO tenant_invitation_audit_events
      (tenant_id, invitation_id, actor_user_id, action, previous_status,
       new_status, outcome, reason_code, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.tenantId, input.invitationId, input.actorUserId, input.action,
      input.previousStatus, input.newStatus, input.outcome, input.reasonCode,
      input.correlationId
    ]
  );
}

/**
 * Creates an invitation and encrypted delivery outbox record atomically.
 * The raw token and target identity are never returned by this service.
 */
export async function createTenantInvitation(
  transaction: TenantTransaction,
  principal: AuthenticatedPrincipal,
  target: ResolvedInvitationTarget,
  role: InvitationRole,
  correlationId: string,
  keys: InvitationKeyMaterial
): Promise<{ readonly invitationId: string; readonly expiresAt: string }> {
  if (!resolvedTargets.has(target as object) ||
      !isInvitationRole(role) || !isUuid(correlationId)) {
    throw new InvitationRequestError();
  }

  await lockAndAuthorizeTenant(transaction, principal);

  if (target.accountSubject) {
    const currentMembership = await transaction.query<{ membership_id: string }>(
      `SELECT membership_id::text AS membership_id
         FROM tenant_memberships
        WHERE tenant_id = $1 AND user_id = $2
          AND status IN ('active', 'suspended')
        LIMIT 1
        FOR UPDATE`,
      [principal.tenantId, target.accountSubject]
    );
    if (currentMembership.length > 0) throw new InvitationConflictError();
  }

  const secrets = createInvitationSecrets(
    target.identityType,
    target.normalizedIdentity,
    keys
  );

  const expired = await transaction.query<InvitationRow>(
    `SELECT invitation_id::text AS invitation_id, status, expires_at::text AS expires_at, version
       FROM tenant_invitations
      WHERE tenant_id = $1
        AND identity_type = $2
        AND identity_fingerprint = $3
        AND status = 'pending'
        AND expires_at <= now()
      FOR UPDATE`,
    [principal.tenantId, target.identityType, secrets.identityFingerprint]
  );

  for (const invitation of expired) {
    const expiryCorrelation = randomUUID();
    await transaction.query(
      `UPDATE tenant_invitations
          SET status = 'expired', version = version + 1
        WHERE tenant_id = $1 AND invitation_id = $2
          AND status = 'pending' AND version = $3`,
      [principal.tenantId, invitation.invitation_id, invitation.version]
    );
    await writeInvitationAudit(transaction, {
      tenantId: principal.tenantId,
      invitationId: invitation.invitation_id,
      actorUserId: principal.subject,
      action: "expired",
      previousStatus: "pending",
      newStatus: "expired",
      outcome: "succeeded",
      reasonCode: "expired_on_create",
      correlationId: expiryCorrelation
    });
  }

  const duplicate = await transaction.query<{ invitation_id: string }>(
    `SELECT invitation_id::text AS invitation_id
       FROM tenant_invitations
      WHERE tenant_id = $1 AND identity_type = $2
        AND identity_fingerprint = $3 AND status = 'pending'
        AND expires_at > now()
      LIMIT 1`,
    [principal.tenantId, target.identityType, secrets.identityFingerprint]
  );
  if (duplicate.length > 0) throw new InvitationConflictError();

  const created = await transaction.query<{
    invitation_id: string;
    expires_at: string;
  }>(
    `INSERT INTO tenant_invitations
      (tenant_id, identity_type, identity_fingerprint, identity_key_version,
       token_hash, token_key_version, role, invited_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + interval '72 hours')
     RETURNING invitation_id::text AS invitation_id, expires_at::text AS expires_at`,
    [
      principal.tenantId,
      secrets.identityType,
      secrets.identityFingerprint,
      keys.identityKeyVersion,
      secrets.tokenHash,
      keys.tokenKeyVersion,
      role,
      principal.subject
    ]
  );
  const row = created[0];
  if (!row) throw new InvitationConflictError();

  await writeInvitationAudit(transaction, {
    tenantId: principal.tenantId,
    invitationId: row.invitation_id,
    actorUserId: principal.subject,
    action: "created",
    previousStatus: null,
    newStatus: "pending",
    outcome: "succeeded",
    reasonCode: "invitation_created",
    correlationId
  });

  const encrypted = encryptInvitationDelivery({
    invitationId: row.invitation_id,
    tenantId: principal.tenantId,
    identityType: secrets.identityType,
    normalizedIdentity: secrets.normalizedIdentity,
    rawToken: secrets.rawToken
  }, keys);

  await transaction.query(
    `INSERT INTO tenant_invitation_delivery_outbox
      (tenant_id, invitation_id, key_version, nonce, ciphertext, auth_tag)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      principal.tenantId,
      row.invitation_id,
      encrypted.keyVersion,
      encrypted.nonce,
      encrypted.ciphertext,
      encrypted.authTag
    ]
  );

  return Object.freeze({
    invitationId: row.invitation_id,
    expiresAt: row.expires_at
  });
}

/** Revokes only a pending invitation; audit and state change share the caller's transaction. */
export async function revokeTenantInvitation(
  transaction: TenantTransaction,
  principal: AuthenticatedPrincipal,
  invitationId: string,
  correlationId: string
): Promise<{ readonly outcome: "succeeded" | "denied" | "noop" }> {
  if (!isUuid(invitationId) || !isUuid(correlationId)) {
    throw new InvitationRequestError();
  }

  await lockAndAuthorizeTenant(transaction, principal);

  const prior = await transaction.query<AuditRow>(
    `SELECT action, outcome, invitation_id::text AS invitation_id, actor_user_id
       FROM tenant_invitation_audit_events
      WHERE tenant_id = $1 AND correlation_id = $2
      LIMIT 1`,
    [principal.tenantId, correlationId]
  );
  if (prior[0]) {
    if (prior[0].action !== "revoked" ||
        prior[0].invitation_id !== invitationId ||
        prior[0].actor_user_id !== principal.subject) {
      throw new InvitationConflictError();
    }
    return Object.freeze({ outcome: prior[0].outcome });
  }

  const rows = await transaction.query<InvitationRow>(
    `SELECT invitation_id::text AS invitation_id, status,
            expires_at::text AS expires_at, expires_at <= now() AS is_expired, version
       FROM tenant_invitations
      WHERE tenant_id = $1 AND invitation_id = $2
      FOR UPDATE`,
    [principal.tenantId, invitationId]
  );
  const invitation = rows[0];
  if (!invitation) {
    await writeInvitationAudit(transaction, {
      tenantId: principal.tenantId,
      invitationId: null,
      actorUserId: principal.subject,
      action: "replay_denied",
      previousStatus: null,
      newStatus: null,
      outcome: "denied",
      reasonCode: "invitation_not_found",
      correlationId
    });
    return Object.freeze({ outcome: "denied" });
  }

  if (invitation.status !== "pending") {
    return Object.freeze({ outcome: invitation.status === "revoked" ? "noop" : "denied" });
  }

  if (invitation.is_expired === true) {
    await transaction.query(
      `UPDATE tenant_invitations
          SET status = 'expired', version = version + 1
        WHERE tenant_id = $1 AND invitation_id = $2
          AND status = 'pending' AND version = $3`,
      [principal.tenantId, invitationId, invitation.version]
    );
    await writeInvitationAudit(transaction, {
      tenantId: principal.tenantId,
      invitationId,
      actorUserId: principal.subject,
      action: "expired",
      previousStatus: "pending",
      newStatus: "expired",
      outcome: "succeeded",
      reasonCode: "expired_on_revoke",
      correlationId
    });
    return Object.freeze({ outcome: "denied" });
  }

  await transaction.query(
    `UPDATE tenant_invitations
        SET status = 'revoked', revoked_by = $1, revoked_at = now(),
            version = version + 1
      WHERE tenant_id = $2 AND invitation_id = $3
        AND status = 'pending' AND version = $4`,
    [principal.subject, principal.tenantId, invitationId, invitation.version]
  );
  await writeInvitationAudit(transaction, {
    tenantId: principal.tenantId,
    invitationId,
    actorUserId: principal.subject,
    action: "revoked",
    previousStatus: "pending",
    newStatus: "revoked",
    outcome: "succeeded",
    reasonCode: "invitation_revoked",
    correlationId
  });
  return Object.freeze({ outcome: "succeeded" });
}
