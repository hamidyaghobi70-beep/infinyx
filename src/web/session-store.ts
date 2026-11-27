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
      await this.pool.query(
        `INSERT INTO web_sessions
           (session_id_hash, user_id, issuer, subject, csrf_token_hash,
            encrypted_token_bundle, idle_expires_at, absolute_expires_at)
         VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8)`,
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
            AND absolute_expires_at > $2`,
        [sessionHash, this.now(), idleExpiresAt]
      );
      return result.rowCount === 1;
    } catch {
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
