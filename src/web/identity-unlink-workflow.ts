import type { Pool } from "pg";
import { hashOpaqueSecret } from "./session-crypto.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type IdentityUnlinkOutcome =
  | { readonly outcome: "unlinked"; readonly outboxId: string }
  | { readonly outcome: "denied" }
  | { readonly outcome: "step_up_required" };

export class IdentityUnlinkWorkflowError extends Error {
  constructor() {
    super("Identity unlink workflow failed.");
    this.name = "IdentityUnlinkWorkflowError";
  }
}

/**
 * Consumes a purpose-bound grant and revokes an identity in one transaction.
 * The canonical issuer/subject binding is never modified or deleted.
 * A per-user advisory lock serializes concurrent unlink attempts.
 */
export async function unlinkVerifiedIdentity(
  pool: Pool,
  userId: string,
  sessionId: string,
  grant: string,
  identityId: string,
  correlationId: string
): Promise<IdentityUnlinkOutcome> {
  if (!UUID_PATTERN.test(userId) || !UUID_PATTERN.test(identityId) ||
      !UUID_PATTERN.test(correlationId)) {
    return { outcome: "denied" };
  }

  let grantHash: Buffer;
  let sessionHash: Buffer;
  try {
    grantHash = hashOpaqueSecret(grant);
    sessionHash = hashOpaqueSecret(sessionId);
  } catch {
    return { outcome: "step_up_required" };
  }

  let client: import("pg").PoolClient;
  try { client = await pool.connect(); }
  catch { throw new IdentityUnlinkWorkflowError(); }

  let open = false;
  let discard = false;
  try {
    await client.query("BEGIN");
    open = true;
    const consumed = await client.query(
      `UPDATE identity_step_up_grants
          SET consumed_at = now()
        WHERE grant_hash = $1
          AND user_id = $2::uuid
          AND session_id_hash = $3
          AND purpose = 'identity_unlink'
          AND consumed_at IS NULL
          AND expires_at > now()`,
      [grantHash, userId, sessionHash]
    );
    if (consumed.rowCount !== 1) {
      await client.query("ROLLBACK");
      open = false;
      return { outcome: "step_up_required" };
    }

    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('identity-unlink:' || $1, 0))",
      [userId]
    );

    const user = await client.query("SELECT 1 FROM users WHERE id = $1::uuid", [userId]);
    if (user.rowCount !== 1) {
      await client.query("ROLLBACK");
      open = false;
      return { outcome: "denied" };
    }

    const target = await client.query(
      `SELECT identity.identity_id
         FROM user_external_identities AS identity
         INNER JOIN user_external_identity_lifecycle AS lifecycle
           ON lifecycle.identity_id = identity.identity_id
        WHERE identity.identity_id = $1::uuid
          AND identity.user_id = $2::uuid
          AND lifecycle.status = 'active'`,
      [identityId, userId]
    );
    if (target.rowCount !== 1) {
      await client.query(
        `INSERT INTO identity_security_audit_events
           (actor_user_id, identity_id, event_type, reason_code, correlation_id)
         VALUES ($1::uuid, NULL, 'external_identity.unlink_denied',
                 'identity_unavailable', $2::uuid)`,
        [userId, correlationId]
      );
      await client.query("COMMIT");
      open = false;
      return { outcome: "denied" };
    }

    const active = await client.query(
      `SELECT count(*)::integer AS active_count
         FROM user_external_identities AS identity
         INNER JOIN user_external_identity_lifecycle AS lifecycle
           ON lifecycle.identity_id = identity.identity_id
        WHERE identity.user_id = $1::uuid AND lifecycle.status = 'active'`,
      [userId]
    );
    if ((active.rows[0]?.active_count ?? 0) <= 1) {
      await client.query(
        `INSERT INTO identity_security_audit_events
           (actor_user_id, identity_id, event_type, reason_code, correlation_id)
         VALUES ($1::uuid, NULL, 'external_identity.unlink_denied',
                 'last_sign_in_method', $2::uuid)`,
        [userId, correlationId]
      );
      await client.query("COMMIT");
      open = false;
      return { outcome: "denied" };
    }

    const changed = await client.query(
      `UPDATE user_external_identity_lifecycle
          SET status = 'revoked',
              version = version + 1,
              updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond'),
              status_changed_by = $2::uuid,
              status_change_reason = 'user_unlinked',
              status_change_correlation_id = $3::uuid
        WHERE identity_id = $1::uuid AND status = 'active'
        RETURNING identity_id::text AS identity_id`,
      [identityId, userId, correlationId]
    );
    if (changed.rowCount !== 1) {
      await client.query(
        `INSERT INTO identity_security_audit_events
           (actor_user_id, identity_id, event_type, reason_code, correlation_id)
         VALUES ($1::uuid, NULL, 'external_identity.unlink_denied',
                 'identity_state_changed', $2::uuid)`,
        [userId, correlationId]
      );
      await client.query("COMMIT");
      open = false;
      return { outcome: "denied" };
    }

    const audit = await client.query<{ event_id: string }>(
      `INSERT INTO identity_security_audit_events
         (actor_user_id, identity_id, event_type, reason_code, correlation_id)
       VALUES ($1::uuid, $2::uuid, 'external_identity.unlink_succeeded',
               'identity_unlinked', $3::uuid)
       RETURNING event_id::text AS event_id`,
      [userId, identityId, correlationId]
    );
    if (!audit.rows[0]) throw new IdentityUnlinkWorkflowError();

    const outbox = await client.query<{ outbox_id: string }>(
      `INSERT INTO identity_session_revocation_outbox (user_id, audit_event_id)
       VALUES ($1::uuid, $2::uuid)
       RETURNING outbox_id::text AS outbox_id`,
      [userId, audit.rows[0].event_id]
    );
    if (!outbox.rows[0]) throw new IdentityUnlinkWorkflowError();

    await client.query("COMMIT");
    open = false;
    return { outcome: "unlinked", outboxId: outbox.rows[0].outbox_id };
  } catch {
    if (open) {
      try { await client.query("ROLLBACK"); }
      catch { discard = true; }
    }
    throw new IdentityUnlinkWorkflowError();
  } finally {
    client.release(discard ? new Error("Discarding failed identity-unlink transaction.") : undefined);
  }
}
