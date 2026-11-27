import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  decryptSessionTokenBundle,
  encryptSessionTokenBundle,
  hashCsrfToken,
  hashOpaqueSecret,
  type SessionTokenBundle
} from "./session-crypto.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class WebSessionStoreError extends Error {
  constructor() {
    super("Web session operation failed.");
    this.name = "WebSessionStoreError";
  }
}

export interface NewWebSession {
  readonly sessionId: string;
  readonly csrfToken: string;
  readonly userId: string;
  readonly issuer: string;
  readonly subject: string;
  readonly tokenBundle: SessionTokenBundle;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
}

export interface StoredWebSession {
  readonly userId: string;
  readonly issuer: string;
  readonly subject: string;
  readonly csrfTokenHash: Buffer;
  readonly csrfToken: string;
  readonly tokenBundle: SessionTokenBundle;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
}

interface SessionRow {
  user_id: string;
  issuer: string;
  subject: string;
  csrf_token_hash: Buffer;
  encrypted_token_bundle: Buffer;
  idle_expires_at: Date | string;
  absolute_expires_at: Date | string;
  refresh_attempt_id?: string | null;
}

export class PostgresWebSessionStore {
  constructor(
    private readonly pool: Pool,
    private readonly encryptionKey: Buffer,
    private readonly now: () => Date = () => new Date()
  ) {
    if (!Buffer.isBuffer(encryptionKey) || encryptionKey.length !== 32) {
      throw new TypeError("Invalid session encryption key.");
    }
  }

  async create(input: NewWebSession): Promise<void> {
    validateNewSession(input);
    try {
      const inserted = await this.pool.query(
        `INSERT INTO web_sessions
           (session_id_hash, user_id, issuer, subject, csrf_token_hash,
            encrypted_token_bundle, idle_expires_at, absolute_expires_at)
         SELECT $1, $2::uuid, $3, $4, $5, $6, $7, $8
          WHERE EXISTS (
            SELECT 1 FROM user_account_security AS account_security
             WHERE account_security.user_id = $2::uuid
               AND account_security.status = 'active'
          )
            AND EXISTS (
              SELECT 1
                FROM user_external_identities AS external_identity
                INNER JOIN user_external_identity_lifecycle AS lifecycle
                  ON lifecycle.identity_id = external_identity.identity_id
               WHERE external_identity.user_id = $2::uuid
                 AND external_identity.issuer = $3
                 AND external_identity.subject = $4
                 AND lifecycle.status = 'active'
            )
            AND NOT EXISTS (
              SELECT 1 FROM user_account_session_revocation_outbox AS account_pending
               WHERE account_pending.user_id = $2::uuid
                 AND account_pending.completed_at IS NULL
            )
            AND NOT EXISTS (
              SELECT 1 FROM identity_session_revocation_outbox AS pending
               WHERE pending.user_id = $2::uuid AND pending.completed_at IS NULL
            )`,
        [
          hashOpaqueSecret(input.sessionId),
          input.userId,
          input.issuer,
          input.subject,
          hashCsrfToken(input.csrfToken),
          encryptSessionTokenBundle({ ...input.tokenBundle, csrfToken: input.csrfToken }, this.encryptionKey),
          input.idleExpiresAt,
          input.absoluteExpiresAt
        ]
      );
      if (inserted.rowCount !== 1) throw new WebSessionStoreError();
    } catch {
      throw new WebSessionStoreError();
    }
  }

  async findActive(sessionId: string): Promise<StoredWebSession | null> {
    let sessionHash: Buffer;
    try { sessionHash = hashOpaqueSecret(sessionId); }
    catch { return null; }
    try {
      const result = await this.pool.query<SessionRow>(
        `SELECT user_id::text AS user_id, issuer, subject, csrf_token_hash,
                encrypted_token_bundle, idle_expires_at, absolute_expires_at
           FROM web_sessions
          WHERE session_id_hash = $1
            AND revoked_at IS NULL
            AND idle_expires_at > $2
            AND absolute_expires_at > $2
            AND EXISTS (
              SELECT 1 FROM user_account_security AS account_security
               WHERE account_security.user_id = web_sessions.user_id
                 AND account_security.status = 'active'
            )
            AND EXISTS (
              SELECT 1
                FROM user_external_identities AS external_identity
                INNER JOIN user_external_identity_lifecycle AS lifecycle
                  ON lifecycle.identity_id = external_identity.identity_id
               WHERE external_identity.user_id = web_sessions.user_id
                 AND external_identity.issuer = web_sessions.issuer
                 AND external_identity.subject = web_sessions.subject
                 AND lifecycle.status = 'active'
            )
            AND NOT EXISTS (
              SELECT 1 FROM user_account_session_revocation_outbox AS account_pending
               WHERE account_pending.user_id = web_sessions.user_id
                 AND account_pending.completed_at IS NULL
            )
             AND NOT EXISTS (
               SELECT 1 FROM identity_session_revocation_outbox AS pending
                WHERE pending.user_id = web_sessions.user_id AND pending.completed_at IS NULL
             )
          LIMIT 1`,
        [sessionHash, this.now()]
      );
      const row = result.rows[0];
      if (!row) return null;
      const tokenBundle = decryptSessionTokenBundle(row.encrypted_token_bundle, this.encryptionKey);
      if (!tokenBundle.csrfToken) throw new WebSessionStoreError();
      return Object.freeze({
        userId: row.user_id,
        issuer: row.issuer,
        subject: row.subject,
        csrfTokenHash: row.csrf_token_hash,
        csrfToken: tokenBundle.csrfToken,
        tokenBundle,
        idleExpiresAt: toDate(row.idle_expires_at),
        absoluteExpiresAt: toDate(row.absolute_expires_at)
      });
    } catch {
      throw new WebSessionStoreError();
    }
  }

  async touch(sessionId: string, idleExpiresAt: Date): Promise<boolean> {
    let sessionHash: Buffer;
    try { sessionHash = hashOpaqueSecret(sessionId); }
    catch { return false; }
    if (!validDate(idleExpiresAt)) return false;
    try {
      const result = await this.pool.query(
        `UPDATE web_sessions
            SET last_seen_at = $2,
                idle_expires_at = LEAST($3, absolute_expires_at)
          WHERE session_id_hash = $1
            AND revoked_at IS NULL
            AND idle_expires_at > $2
            AND absolute_expires_at > $2
            AND EXISTS (
              SELECT 1 FROM user_account_security AS account_security
               WHERE account_security.user_id = web_sessions.user_id
                 AND account_security.status = 'active'
            )
            AND EXISTS (
              SELECT 1
                FROM user_external_identities AS external_identity
                INNER JOIN user_external_identity_lifecycle AS lifecycle
                  ON lifecycle.identity_id = external_identity.identity_id
               WHERE external_identity.user_id = web_sessions.user_id
                 AND external_identity.issuer = web_sessions.issuer
                 AND external_identity.subject = web_sessions.subject
                 AND lifecycle.status = 'active'
            )
            AND NOT EXISTS (
              SELECT 1 FROM user_account_session_revocation_outbox AS account_pending
               WHERE account_pending.user_id = web_sessions.user_id
                 AND account_pending.completed_at IS NULL
            )
             AND NOT EXISTS (
               SELECT 1 FROM identity_session_revocation_outbox AS pending
                WHERE pending.user_id = web_sessions.user_id AND pending.completed_at IS NULL
             )`,
        [sessionHash, this.now(), idleExpiresAt]
      );
      return result.rowCount === 1;
    } catch {
      throw new WebSessionStoreError();
    }
  }

  async getUsableAccessToken(
    sessionId: string,
    refresh: (refreshToken: string) => Promise<{
      readonly accessToken: string;
      readonly refreshToken?: string;
      readonly accessTokenExpiresAt: number;
    }>
  ): Promise<string | null> {
    let sessionHash: Buffer;
    try { sessionHash = hashOpaqueSecret(sessionId); } catch { return null; }

    const now = this.now();
    let row: SessionRow | undefined;
    try {
      const selected = await this.pool.query<SessionRow>(
        `SELECT user_id::text AS user_id, issuer, subject, csrf_token_hash,
                encrypted_token_bundle, idle_expires_at, absolute_expires_at,
                refresh_attempt_id
           FROM web_sessions
          WHERE session_id_hash = $1 AND revoked_at IS NULL
            AND refresh_attempt_id IS NULL
            AND idle_expires_at > $2 AND absolute_expires_at > $2
            AND EXISTS (
              SELECT 1 FROM user_account_security s
               WHERE s.user_id = web_sessions.user_id AND s.status = 'active'
            )
            AND EXISTS (
              SELECT 1 FROM user_external_identities i
              INNER JOIN user_external_identity_lifecycle l ON l.identity_id = i.identity_id
               WHERE i.user_id = web_sessions.user_id AND i.issuer = web_sessions.issuer
                 AND i.subject = web_sessions.subject AND l.status = 'active'
            )
            AND NOT EXISTS (
              SELECT 1 FROM user_account_session_revocation_outbox o
               WHERE o.user_id = web_sessions.user_id AND o.completed_at IS NULL
            )
            AND NOT EXISTS (
              SELECT 1 FROM identity_session_revocation_outbox o
               WHERE o.user_id = web_sessions.user_id AND o.completed_at IS NULL
            )
          LIMIT 1`,
        [sessionHash, now]
      );
      row = selected.rows[0];
    } catch {
      throw new WebSessionStoreError();
    }
    if (!row) return null;

    let current: SessionTokenBundle;
    try { current = decryptSessionTokenBundle(row.encrypted_token_bundle, this.encryptionKey); }
    catch { throw new WebSessionStoreError(); }
    if (!current.csrfToken) throw new WebSessionStoreError();
    if (current.accessTokenExpiresAt > now.getTime() + 60_000) return current.accessToken;

    if (!current.refreshToken) {
      try {
        await this.pool.query(
          `UPDATE web_sessions SET revoked_at = $3
            WHERE session_id_hash = $1 AND encrypted_token_bundle = $2
              AND refresh_attempt_id IS NULL AND revoked_at IS NULL`,
          [sessionHash, row.encrypted_token_bundle, now]
        );
      } catch { throw new WebSessionStoreError(); }
      return null;
    }

    const attemptId = randomUUID();
    let reservation: { rowCount: number | null };
    try {
      reservation = await this.pool.query(
        `UPDATE web_sessions
            SET refresh_attempt_id = $2
          WHERE session_id_hash = $1
            AND encrypted_token_bundle = $3
            AND refresh_attempt_id IS NULL
            AND revoked_at IS NULL
            AND idle_expires_at > $4 AND absolute_expires_at > $4
            AND EXISTS (
              SELECT 1 FROM user_account_security s
               WHERE s.user_id = web_sessions.user_id AND s.status = 'active'
            )
            AND EXISTS (
              SELECT 1 FROM user_external_identities i
              INNER JOIN user_external_identity_lifecycle l ON l.identity_id = i.identity_id
               WHERE i.user_id = web_sessions.user_id AND i.issuer = web_sessions.issuer
                 AND i.subject = web_sessions.subject AND l.status = 'active'
            )
            AND NOT EXISTS (
              SELECT 1 FROM user_account_session_revocation_outbox o
               WHERE o.user_id = web_sessions.user_id AND o.completed_at IS NULL
            )
            AND NOT EXISTS (
              SELECT 1 FROM identity_session_revocation_outbox o
               WHERE o.user_id = web_sessions.user_id AND o.completed_at IS NULL
            )`,
        [sessionHash, attemptId, row.encrypted_token_bundle, now]
      );
    } catch { throw new WebSessionStoreError(); }
    if (reservation.rowCount !== 1) return null;

    let refreshed: {
      readonly accessToken: string;
      readonly refreshToken?: string;
      readonly accessTokenExpiresAt: number;
    };
    try {
      // The durable reservation is committed before this network request. No
      // PostgreSQL client or transaction remains checked out while it runs.
      refreshed = await refresh(current.refreshToken);
    } catch {
      try {
        await this.pool.query(
          `UPDATE web_sessions SET revoked_at = $3
            WHERE session_id_hash = $1 AND refresh_attempt_id = $2 AND revoked_at IS NULL`,
          [sessionHash, attemptId, this.now()]
        );
      } catch { throw new WebSessionStoreError(); }
      return null;
    }

    const refreshedAt = this.now();
    if (!refreshed || typeof refreshed.accessToken !== "string" ||
        refreshed.accessToken.length < 1 || refreshed.accessToken.length > 16_384 ||
        !Number.isSafeInteger(refreshed.accessTokenExpiresAt) ||
        refreshed.accessTokenExpiresAt <= refreshedAt.getTime() ||
        refreshed.accessTokenExpiresAt > refreshedAt.getTime() + 86_400_000 ||
        (refreshed.refreshToken !== undefined &&
          (typeof refreshed.refreshToken !== "string" ||
           refreshed.refreshToken.length < 1 || refreshed.refreshToken.length > 16_384))) {
      try {
        await this.pool.query(
          `UPDATE web_sessions SET revoked_at = $3
            WHERE session_id_hash = $1 AND refresh_attempt_id = $2 AND revoked_at IS NULL`,
          [sessionHash, attemptId, refreshedAt]
        );
      } catch { throw new WebSessionStoreError(); }
      return null;
    }

    const nextBundle: SessionTokenBundle = Object.freeze({
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken ?? current.refreshToken,
      accessTokenExpiresAt: refreshed.accessTokenExpiresAt,
      csrfToken: current.csrfToken
    });
    try {
      const updated = await this.pool.query(
        `UPDATE web_sessions
            SET encrypted_token_bundle = $3,
                refresh_attempt_id = NULL,
                last_seen_at = $4
          WHERE session_id_hash = $1 AND refresh_attempt_id = $2
            AND encrypted_token_bundle = $5
            AND revoked_at IS NULL AND idle_expires_at > $4 AND absolute_expires_at > $4
            AND EXISTS (
              SELECT 1 FROM user_account_security s
               WHERE s.user_id = web_sessions.user_id AND s.status = 'active'
            )
            AND EXISTS (
              SELECT 1 FROM user_external_identities i
              INNER JOIN user_external_identity_lifecycle l ON l.identity_id = i.identity_id
               WHERE i.user_id = web_sessions.user_id AND i.issuer = web_sessions.issuer
                 AND i.subject = web_sessions.subject AND l.status = 'active'
            )
            AND NOT EXISTS (
              SELECT 1 FROM user_account_session_revocation_outbox o
               WHERE o.user_id = web_sessions.user_id AND o.completed_at IS NULL
            )
            AND NOT EXISTS (
              SELECT 1 FROM identity_session_revocation_outbox o
               WHERE o.user_id = web_sessions.user_id AND o.completed_at IS NULL
            )`,
        [sessionHash, attemptId, encryptSessionTokenBundle(nextBundle, this.encryptionKey),
          refreshedAt, row.encrypted_token_bundle]
      );
      return updated.rowCount === 1 ? nextBundle.accessToken : null;
    } catch {
      // Keep the reservation if persistence is uncertain: the provider may have
      // rotated its single-use token, so retrying the previous token is unsafe.
      throw new WebSessionStoreError();
    }
  }

  async revoke(sessionId: string): Promise<void> {
    let sessionHash: Buffer;
    try { sessionHash = hashOpaqueSecret(sessionId); }
    catch { return; }
    try {
      await this.pool.query(
        `UPDATE web_sessions SET revoked_at = $2
          WHERE session_id_hash = $1 AND revoked_at IS NULL`,
        [sessionHash, this.now()]
      );
    } catch {
      throw new WebSessionStoreError();
    }
  }

  async revokeAllForUser(userId: string): Promise<void> {
    if (!UUID_PATTERN.test(userId)) throw new TypeError("Invalid user identifier.");
    try {
      await this.pool.query(
        `UPDATE web_sessions SET revoked_at = $2
          WHERE user_id = $1::uuid AND revoked_at IS NULL`,
        [userId, this.now()]
      );
    } catch {
      throw new WebSessionStoreError();
    }
  }
}

function validateNewSession(input: NewWebSession): void {
  if (!input || !UUID_PATTERN.test(input.userId) ||
      typeof input.issuer !== "string" || input.issuer.length < 1 || input.issuer.length > 2048 ||
      typeof input.subject !== "string" || input.subject.length < 1 || input.subject.length > 512 ||
      !validDate(input.idleExpiresAt) || !validDate(input.absoluteExpiresAt) ||
      input.idleExpiresAt > input.absoluteExpiresAt) {
    throw new TypeError("Invalid web session.");
  }
  try {
    const issuer = new URL(input.issuer);
    if (issuer.protocol !== "https:" || issuer.username || issuer.password || issuer.search || issuer.hash) {
      throw new TypeError("Invalid issuer.");
    }
    hashOpaqueSecret(input.sessionId);
    hashCsrfToken(input.csrfToken);
  } catch {
    throw new TypeError("Invalid web session.");
  }
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? new Date(value.getTime()) : new Date(value);
}
