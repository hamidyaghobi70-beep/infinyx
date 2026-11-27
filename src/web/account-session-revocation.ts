import type { Pool } from "pg";
import type { PostgresWebSessionStore } from "./session-store.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class AccountSessionRevocationError extends Error {
  constructor() {
    super("Account session revocation failed.");
    this.name = "AccountSessionRevocationError";
  }
}

/**
 * A pending account-security outbox row is a fail-closed barrier in every
 * session lookup. Mark it complete only after all persisted sessions have
 * been revoked successfully.
 */
export async function completeAccountSessionRevocation(
  pool: Pool,
  sessions: PostgresWebSessionStore,
  userId: string,
  outboxId: string
): Promise<boolean> {
  if (!UUID_PATTERN.test(userId) || !UUID_PATTERN.test(outboxId)) return false;

  try {
    await sessions.revokeAllForUser(userId);
    const completed = await pool.query(
      `UPDATE user_account_session_revocation_outbox
          SET completed_at = now(), attempts = attempts + 1, last_error_code = NULL
        WHERE outbox_id = $1::uuid
          AND user_id = $2::uuid
          AND completed_at IS NULL`,
      [outboxId, userId]
    );
    if (completed.rowCount === 1) return true;

    const current = await pool.query<{ completed_at: Date | null }>(
      `SELECT completed_at
         FROM user_account_session_revocation_outbox
        WHERE outbox_id = $1::uuid AND user_id = $2::uuid`,
      [outboxId, userId]
    );
    return current.rows[0]?.completed_at !== null &&
      current.rows[0]?.completed_at !== undefined;
  } catch {
    try {
      await pool.query(
        `UPDATE user_account_session_revocation_outbox
            SET attempts = attempts + 1, last_error_code = 'session_revocation_failed'
          WHERE outbox_id = $1::uuid
            AND user_id = $2::uuid
            AND completed_at IS NULL`,
        [outboxId, userId]
      );
    } catch {
      // The uncompleted outbox row remains the fail-closed session barrier.
    }
    return false;
  }
}

export async function retryPendingAccountSessionRevocations(
  pool: Pool,
  sessions: PostgresWebSessionStore
): Promise<number> {
  const pending = await pool.query<{ outbox_id: string; user_id: string }>(
    `SELECT outbox_id::text AS outbox_id, user_id::text AS user_id
       FROM user_account_session_revocation_outbox
      WHERE completed_at IS NULL
      ORDER BY requested_at
      LIMIT 100`
  );
  let failures = 0;
  for (const item of pending.rows) {
    if (!await completeAccountSessionRevocation(pool, sessions, item.user_id, item.outbox_id)) {
      failures += 1;
    }
  }
  return failures;
}
