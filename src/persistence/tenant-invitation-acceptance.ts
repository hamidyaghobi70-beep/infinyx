import { randomUUID } from "node:crypto";
import type { AuthenticatedPrincipal } from "../core/authenticated-principal.js";
import {
  constantTimeEqual32,
  fingerprintInvitationIdentity,
  hashInvitationToken,
  normalizeInvitationIdentity,
  type InvitationKeyMaterial,
  type InvitationIdentityType
} from "./tenant-invitation-crypto.js";
import { withInvitationTenantTransaction, type TenantSqlPool, type TenantTransaction } from "./tenant-transaction.js";

export interface VerifiedInvitationIdentity {
  readonly subject: string;
  readonly identityType: InvitationIdentityType;
  readonly identity: string;
  readonly issuer: string;
  readonly audience: string;
  readonly verifiedAt: number;
}

/**
 * Must be implemented by the selected authentication provider. It must
 * cryptographically validate provider assertions and bind the verified
 * identity to the authenticated principal's subject.
 */
export interface InvitationIdentityVerifier {
  verifyAuthenticatedIdentity(
    principal: AuthenticatedPrincipal
  ): Promise<VerifiedInvitationIdentity>;
}

export class InvitationAcceptanceUnavailableError extends Error {
  constructor() {
    super("Invitation acceptance identity verification is unavailable.");
    this.name = "InvitationAcceptanceUnavailableError";
  }
}

export interface InvitationAcceptanceResult {
  readonly outcome: "accepted" | "denied";
  readonly tenantId?: string;
  readonly membershipId?: string;
  readonly generation?: number;
  readonly role?: "admin" | "manager" | "editor" | "viewer";
}

interface AcceptanceInvitationRow {
  invitation_id: string;
  identity_type: string;
  identity_fingerprint: Buffer;
  identity_key_version: number;
  token_key_version: number;
  role: string;
  status: string;
  is_expired: boolean;
  version: string | number;
}

async function writeAcceptanceAudit(
  transaction: TenantTransaction,
  input: {
    tenantId: string;
    invitationId: string;
    actorUserId: string;
    action: "accepted" | "expired" | "acceptance_denied" | "replay_denied";
    previousStatus: string;
    newStatus: string;
    outcome: "succeeded" | "denied";
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
 * Accepts an invitation only with a trusted provider assertion. The token
 * lookup resolves tenant scope inside the database; no client tenant ID is used.
 */
export async function acceptTenantInvitation(
  pool: TenantSqlPool,
  principal: AuthenticatedPrincipal,
  rawToken: string,
  verifier: InvitationIdentityVerifier | null,
  keys: InvitationKeyMaterial
): Promise<InvitationAcceptanceResult> {
  if (!verifier) throw new InvitationAcceptanceUnavailableError();

  let assertion: VerifiedInvitationIdentity;
  try {
    assertion = await verifier.verifyAuthenticatedIdentity(principal);
  } catch {
    throw new InvitationAcceptanceUnavailableError();
  }

  if (
    !assertion ||
    assertion.subject !== principal.subject ||
    (assertion.identityType !== "email" && assertion.identityType !== "phone") ||
    typeof assertion.issuer !== "string" || assertion.issuer.length < 1 ||
    typeof assertion.audience !== "string" || assertion.audience.length < 1 ||
    !Number.isFinite(assertion.verifiedAt) ||
    assertion.verifiedAt > Date.now() / 1000
  ) {
    throw new InvitationAcceptanceUnavailableError();
  }

  const normalizedIdentity = normalizeInvitationIdentity(
    assertion.identityType,
    assertion.identity
  );
  const tokenHash = hashInvitationToken(rawToken, keys.tokenKey);
  const identityFingerprint = fingerprintInvitationIdentity(
    assertion.identityType,
    normalizedIdentity,
    keys.identityKey
  );
  const correlationId = randomUUID();

  return withInvitationTenantTransaction(
    pool,
    principal,
    tokenHash,
    async (transaction, tenantId) => {
      const tenantRows = await transaction.query<{ id: string }>(
        "SELECT id FROM tenants WHERE id = $1 FOR UPDATE",
        [tenantId]
      );
      if (tenantRows.length !== 1) {
        return Object.freeze({ outcome: "denied" as const });
      }

      const rows = await transaction.query<AcceptanceInvitationRow>(
        `SELECT invitation_id::text AS invitation_id, identity_type,
                identity_fingerprint, identity_key_version, token_key_version,
                role, status, expires_at <= now() AS is_expired, version
           FROM tenant_invitations
          WHERE tenant_id = $1 AND token_hash = $2
          FOR UPDATE`,
        [tenantId, tokenHash]
      );
      const invitation = rows[0];
      if (!invitation) return Object.freeze({ outcome: "denied" as const });

      if (invitation.status !== "pending") {
        await writeAcceptanceAudit(transaction, {
          tenantId,
          invitationId: invitation.invitation_id,
          actorUserId: principal.subject,
          action: "replay_denied",
          previousStatus: invitation.status,
          newStatus: invitation.status,
          outcome: "denied",
          reasonCode: "invitation_not_pending",
          correlationId
        });
        return Object.freeze({ outcome: "denied" as const });
      }

      if (invitation.is_expired) {
        await transaction.query(
          `UPDATE tenant_invitations
              SET status = 'expired', version = version + 1
            WHERE tenant_id = $1 AND invitation_id = $2
              AND status = 'pending' AND version = $3`,
          [tenantId, invitation.invitation_id, invitation.version]
        );
        await writeAcceptanceAudit(transaction, {
          tenantId,
          invitationId: invitation.invitation_id,
          actorUserId: principal.subject,
          action: "expired",
          previousStatus: "pending",
          newStatus: "expired",
          outcome: "succeeded",
          reasonCode: "expired_on_acceptance",
          correlationId
        });
        return Object.freeze({ outcome: "denied" as const });
      }

      if (
        invitation.token_key_version !== keys.tokenKeyVersion ||
        invitation.identity_key_version !== keys.identityKeyVersion
      ) {
        throw new InvitationAcceptanceUnavailableError();
      }

      if (
        invitation.identity_type !== assertion.identityType ||
        !constantTimeEqual32(identityFingerprint, invitation.identity_fingerprint)
      ) {
        await writeAcceptanceAudit(transaction, {
          tenantId,
          invitationId: invitation.invitation_id,
          actorUserId: principal.subject,
          action: "acceptance_denied",
          previousStatus: "pending",
          newStatus: "pending",
          outcome: "denied",
          reasonCode: "identity_mismatch",
          correlationId
        });
        return Object.freeze({ outcome: "denied" as const });
      }

      const current = await transaction.query<{ membership_id: string }>(
        `SELECT membership_id::text AS membership_id
           FROM tenant_memberships
          WHERE tenant_id = $1 AND user_id = $2
            AND status IN ('active', 'suspended')
          LIMIT 1
          FOR UPDATE`,
        [tenantId, principal.subject]
      );
      if (current.length > 0) {
        await writeAcceptanceAudit(transaction, {
          tenantId,
          invitationId: invitation.invitation_id,
          actorUserId: principal.subject,
          action: "acceptance_denied",
          previousStatus: "pending",
          newStatus: "pending",
          outcome: "denied",
          reasonCode: "current_membership_exists",
          correlationId
        });
        return Object.freeze({ outcome: "denied" as const });
      }

      const latest = await transaction.query<{ generation: number; status: string }>(
        `SELECT generation, status
           FROM tenant_memberships
          WHERE tenant_id = $1 AND user_id = $2
          ORDER BY generation DESC
          LIMIT 1
          FOR UPDATE`,
        [tenantId, principal.subject]
      );
      const latestMembership = latest[0];
      if (latestMembership && latestMembership.status !== "removed") {
        return Object.freeze({ outcome: "denied" as const });
      }
      const generation = latestMembership ? latestMembership.generation + 1 : 1;
      if (!Number.isSafeInteger(generation) || generation < 1) {
        throw new InvitationAcceptanceUnavailableError();
      }

      const role = invitation.role;
      if (!["admin", "manager", "editor", "viewer"].includes(role)) {
        throw new InvitationAcceptanceUnavailableError();
      }

      const memberships = await transaction.query<{ membership_id: string }>(
        `INSERT INTO tenant_memberships (tenant_id, user_id, role, generation)
         VALUES ($1, $2, $3, $4)
         RETURNING membership_id::text AS membership_id`,
        [tenantId, principal.subject, role, generation]
      );
      const membershipId = memberships[0]?.membership_id;
      if (!membershipId) throw new InvitationAcceptanceUnavailableError();

      await transaction.query(
        `UPDATE tenant_invitations
            SET status = 'accepted', accepted_by = $1, accepted_at = now(),
                version = version + 1
          WHERE tenant_id = $2 AND invitation_id = $3
            AND status = 'pending' AND version = $4`,
        [principal.subject, tenantId, invitation.invitation_id, invitation.version]
      );
      await writeAcceptanceAudit(transaction, {
        tenantId,
        invitationId: invitation.invitation_id,
        actorUserId: principal.subject,
        action: "accepted",
        previousStatus: "pending",
        newStatus: "accepted",
        outcome: "succeeded",
        reasonCode: "invitation_accepted",
        correlationId
      });

      return Object.freeze({
        outcome: "accepted" as const,
        tenantId,
        membershipId,
        generation,
        role: role as "admin" | "manager" | "editor" | "viewer"
      });
    }
  );
}
