import type { Pool, PoolClient } from "pg";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type AccountRecoveryResult =
  | { readonly outcome: "recovered"; readonly userId: string; readonly outboxId: string }
  | { readonly outcome: "denied" };

export class AccountRecoveryWorkflowError extends Error {
  constructor() {
    super("Account recovery workflow failed.");
    this.name = "AccountRecoveryWorkflowError";
  }
}

function validateInput(issuer: string, subject: string, correlationId: string): void {
  if (typeof issuer !== "string" || issuer.length < 1 || issuer.length > 2048 ||
      typeof subject !== "string" || subject.length < 1 || subject.length > 512 ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(subject) ||
      !UUID_PATTERN.test(correlationId)) {
    throw new TypeError("Invalid verified account recovery identity.");
  }
  let parsed: URL;
  try { parsed = new URL(issuer); } catch { throw new TypeError("Invalid verified account recovery identity."); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError("Invalid verified account recovery identity.");
  }
}

async function auditDenied(
  client: PoolClient,
  userId: string | null,
  identityId: string | null,
  correlationId: string
): Promise<void> {
  await client.query(
    `INSERT INTO user_account_recovery_audit_events
       (user_id, identity_id, outcome, reason_code, correlation_id)
     VALUES ($1::uuid, $2::uuid, 'denied', 'recovery_not_permitted', $3::uuid)`,
    [userId, identityId, correlationId]
  );
}

/**
 * Reactivates only a suspended account after the callback has proved a fresh
 * OIDC authentication for an exact, already-bound, active identity.
 * Identity bindings and identity lifecycle rows are read/locked, never changed.
 */
export async function recoverSuspendedAccount(
  pool: Pool,
  issuer: string,
  subject: string,
  correlationId: string
): Promise<AccountRecoveryResult> {
  validateInput(issuer, subject, correlationId);

  let client: PoolClient;
  try { client = await pool.connect(); }
  catch { throw new AccountRecoveryWorkflowError(); }

  let open = false;
  let discard = false;
  try {
    await client.query("BEGIN");
    open = true;

    const mapped = await client.query<{ user_id: string; identity_id: string }>(
      `SELECT user_id::text AS user_id, identity_id::text AS identity_id
         FROM user_external_identities
        WHERE issuer = $1 AND subject = $2
        LIMIT 1`,
      [issuer, subject]
    );
    const first = mapped.rows[0];
    if (!first) {
      await auditDenied(client, null, null, correlationId);
      await client.query("COMMIT");
      open = false;
      return { outcome: "denied" };
    }

    // Follow the same user -> identity -> lifecycle -> account-state lock order
    // as the identity unlink workflow to avoid cross-workflow deadlocks.
    const user = await client.query(
      "SELECT id FROM users WHERE id = $1::uuid FOR UPDATE",
      [first.user_id]
    );
    if (user.rowCount !== 1) {
      await auditDenied(client, null, first.identity_id, correlationId);
      await client.query("COMMIT");
      open = false;
      return { outcome: "denied" };
    }

    const identity = await client.query<{ user_id: string; identity_id: string }>(
      `SELECT user_id::text AS user_id, identity_id::text AS identity_id
         FROM user_external_identities
        WHERE issuer = $1 AND subject = $2
        FOR UPDATE`,
      [issuer, subject]
    );
    const currentIdentity = identity.rows[0];
    if (!currentIdentity || currentIdentity.user_id !== first.user_id ||
        currentIdentity.identity_id !== first.identity_id) {
      await auditDenied(client, first.user_id, first.identity_id, correlationId);
      await client.query("COMMIT");
      open = false;
      return { outcome: "denied" };
    }

    const lifecycle = await client.query<{ status: string }>(
      `SELECT status
         FROM user_external_identity_lifecycle
        WHERE identity_id = $1::uuid
        FOR UPDATE`,
      [currentIdentity.identity_id]
    );
    const account = await client.query<{ status: string; version: number }>(
      `SELECT status, version
         FROM user_account_security
        WHERE user_id = $1::uuid
        FOR UPDATE`,
      [currentIdentity.user_id]
    );

    if (lifecycle.rows[0]?.status !== "active" ||
        account.rows[0]?.status !== "suspended") {
      await auditDenied(client, currentIdentity.user_id, currentIdentity.identity_id, correlationId);
      await client.query("COMMIT");
      open = false;
      return { outcome: "denied" };
    }

    const changed = await client.query(
      `UPDATE user_account_security
          SET status = 'active',
              version = version + 1,
              updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond'),
              status_changed_by = $2::uuid,
              status_change_reason = 'account_recovered',
              status_change_correlation_id = $3::uuid
        WHERE user_id = $1::uuid
          AND status = 'suspended'`,
      [currentIdentity.user_id, currentIdentity.user_id, correlationId]
    );
    if (changed.rowCount !== 1) {
      await auditDenied(client, currentIdentity.user_id, currentIdentity.identity_id, correlationId);
      await client.query("COMMIT");
      open = false;
      return { outcome: "denied" };
    }

    await client.query(
      `INSERT INTO user_account_recovery_audit_events
         (user_id, identity_id, outcome, reason_code, correlation_id)
       VALUES ($1::uuid, $2::uuid, 'succeeded', 'active_identity_proved', $3::uuid)`,
      [currentIdentity.user_id, currentIdentity.identity_id, correlationId]
    );

    const outbox = await client.query<{ outbox_id: string }>(
      `SELECT outbox_id::text AS outbox_id
         FROM user_account_session_revocation_outbox
        WHERE user_id = $1::uuid AND completed_at IS NULL
        ORDER BY requested_at
        LIMIT 1`,
      [currentIdentity.user_id]
    );
    if (!outbox.rows[0]) throw new AccountRecoveryWorkflowError();

    await client.query("COMMIT");
    open = false;
    return {
      outcome: "recovered",
      userId: currentIdentity.user_id,
      outboxId: outbox.rows[0].outbox_id
    };
  } catch {
    if (open) {
      try { await client.query("ROLLBACK"); }
      catch { discard = true; }
    }
    throw new AccountRecoveryWorkflowError();
  } finally {
    client.release(discard ? new Error("Discarding failed account recovery transaction.") : undefined);
  }
}
