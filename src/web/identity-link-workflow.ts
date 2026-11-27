import type { Pool } from "pg";
import type { PostgresWebSessionStore } from "./session-store.js";

export type IdentityLinkOutcome =
  | { readonly outcome: "linked"; readonly outboxId: string }
  | { readonly outcome: "already_linked" }
  | { readonly outcome: "denied" };

export class IdentityLinkWorkflowError extends Error {
  constructor() {
    super("Identity link workflow failed.");
    this.name = "IdentityLinkWorkflowError";
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function validateIdentity(userId: string, issuer: string, subject: string, correlationId: string): void {
  if (!UUID_PATTERN.test(userId) || !UUID_PATTERN.test(correlationId) ||
      typeof issuer !== "string" || issuer.length < 1 || issuer.length > 2048 ||
      typeof subject !== "string" || subject.length < 1 || subject.length > 512 ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(subject)) {
    throw new TypeError("Invalid verified external identity.");
  }
  let parsed: URL;
  try { parsed = new URL(issuer); } catch { throw new TypeError("Invalid verified external identity."); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError("Invalid verified external identity.");
  }
}

/**
 * Persists a new immutable identity binding, its audit event, and a durable
 * session-revocation request in one transaction. Existing identity and
 * lifecycle rows are only locked/read; they are never updated or deleted.
 */
export async function registerVerifiedIdentityLink(
  pool: Pool,
  userId: string,
  issuer: string,
  subject: string,
  correlationId: string
): Promise<IdentityLinkOutcome> {
  validateIdentity(userId, issuer, subject, correlationId);
  let client: import("pg").PoolClient;
  try { client = await pool.connect(); }
  catch { throw new IdentityLinkWorkflowError(); }

  let open = false;
  let discard = false;
  try {
    await client.query("BEGIN");
    open = true;
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1 || E'\\n' || $2, 0))",
      [issuer, subject]
    );
    const user = await client.query(
      "SELECT id FROM users WHERE id = $1::uuid",
      [userId]
    );
    if (user.rowCount !== 1) {
      await client.query("ROLLBACK");
      open = false;
      return { outcome: "denied" };
    }

    const inserted = await client.query<{ identity_id: string }>(
      `INSERT INTO user_external_identities (user_id, issuer, subject)
       VALUES ($1::uuid, $2, $3)
       ON CONFLICT (issuer, subject) DO NOTHING
       RETURNING identity_id::text AS identity_id`,
      [userId, issuer, subject]
    );

    if (inserted.rows[0]) {
      const identityId = inserted.rows[0].identity_id;
      const audit = await client.query<{ event_id: string }>(
        `INSERT INTO identity_security_audit_events
           (actor_user_id, identity_id, event_type, reason_code, correlation_id)
         VALUES ($1::uuid, $2::uuid, 'external_identity.link_succeeded',
                 'identity_linked', $3::uuid)
         RETURNING event_id::text AS event_id`,
        [userId, identityId, correlationId]
      );
      if (!audit.rows[0]) throw new IdentityLinkWorkflowError();
      const outbox = await client.query<{ outbox_id: string }>(
        `INSERT INTO identity_session_revocation_outbox (user_id, audit_event_id)
         VALUES ($1::uuid, $2::uuid)
         RETURNING outbox_id::text AS outbox_id`,
        [userId, audit.rows[0].event_id]
      );
      if (!outbox.rows[0]) throw new IdentityLinkWorkflowError();
      await client.query("COMMIT");
      open = false;
      return { outcome: "linked", outboxId: outbox.rows[0].outbox_id };
    }

    const existing = await client.query<{
      user_id: string;
      identity_id: string;
      lifecycle_status: string | null;
    }>(
      `SELECT identity.user_id::text AS user_id,
              identity.identity_id::text AS identity_id,
              lifecycle.status AS lifecycle_status
         FROM user_external_identities AS identity
         LEFT JOIN user_external_identity_lifecycle AS lifecycle
           ON lifecycle.identity_id = identity.identity_id
        WHERE identity.issuer = $1 AND identity.subject = $2
        `,
      [issuer, subject]
    );
    const row = existing.rows[0];
    let outcome: "already_linked" | "denied" = "denied";
    let eventType = "external_identity.link_denied";
    let reason = "identity_conflict";
    let auditIdentityId: string | null = null;
    if (row && row.user_id === userId && row.lifecycle_status === "active") {
      outcome = "already_linked";
      eventType = "external_identity.link_idempotent";
      reason = "already_linked";
      auditIdentityId = row.identity_id;
    } else if (row && row.user_id === userId && row.lifecycle_status === null) {
      reason = "lifecycle_missing";
    } else if (row && row.user_id === userId) {
      reason = "identity_inactive";
    }

    await client.query(
      `INSERT INTO identity_security_audit_events
         (actor_user_id, identity_id, event_type, reason_code, correlation_id)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid)`,
      [userId, auditIdentityId, eventType, reason, correlationId]
    );
    await client.query("COMMIT");
    open = false;
    return { outcome };
  } catch {
    if (open) {
      try { await client.query("ROLLBACK"); }
      catch { discard = true; }
    }
    throw new IdentityLinkWorkflowError();
  } finally {
    client.release(discard ? new Error("Discarding failed identity-link transaction.") : undefined);
  }
}

export async function completeIdentitySessionRevocation(
  pool: Pool,
  sessions: PostgresWebSessionStore,
  userId: string,
  outboxId: string
): Promise<boolean> {
  if (!UUID_PATTERN.test(userId) || !UUID_PATTERN.test(outboxId)) return false;
  try {
    await sessions.revokeAllForUser(userId);
    const completed = await pool.query(
      `UPDATE identity_session_revocation_outbox
          SET completed_at = now(), attempts = attempts + 1, last_error_code = NULL
        WHERE outbox_id = $1::uuid AND user_id = $2::uuid AND completed_at IS NULL`,
      [outboxId, userId]
    );
    return completed.rowCount === 1;
  } catch {
    try {
      await pool.query(
        `UPDATE identity_session_revocation_outbox
            SET attempts = attempts + 1, last_error_code = 'session_revocation_failed'
          WHERE outbox_id = $1::uuid AND user_id = $2::uuid AND completed_at IS NULL`,
        [outboxId, userId]
      );
    } catch { /* the pending outbox row remains the fail-closed barrier */ }
    return false;
  }
}

export async function retryPendingIdentitySessionRevocations(
  pool: Pool,
  sessions: PostgresWebSessionStore
): Promise<void> {
  const pending = await pool.query<{ outbox_id: string; user_id: string }>(
    `SELECT outbox_id::text AS outbox_id, user_id::text AS user_id
       FROM identity_session_revocation_outbox
      WHERE completed_at IS NULL
      ORDER BY requested_at
      LIMIT 100`
  );
  for (const item of pending.rows) {
    await completeIdentitySessionRevocation(pool, sessions, item.user_id, item.outbox_id);
  }
}
