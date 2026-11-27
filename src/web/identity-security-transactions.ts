import type { Pool } from "pg";
import {
  createOpaqueSessionId,
  decryptIdentitySecurityTransactionPayload,
  encryptIdentitySecurityTransactionPayload,
  hashOpaqueSecret,
  type IdentitySecurityTransactionPayload
} from "./session-crypto.js";

const MAX_TRANSACTION_LIFETIME_MS = 5 * 60 * 1000;
const MAX_STEP_UP_LIFETIME_MS = 5 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type IdentitySecurityTransactionPurpose =
  | "reauth_identity_link"
  | "reauth_identity_unlink";

export type IdentityStepUpPurpose = "identity_link" | "identity_unlink";

export class IdentitySecurityTransactionStoreError extends Error {
  constructor() {
    super("Identity security transaction operation failed.");
    this.name = "IdentitySecurityTransactionStoreError";
  }
}

export interface ConsumedIdentitySecurityTransaction {
  readonly transactionId: string;
  readonly payload: IdentitySecurityTransactionPayload;
}

export class PostgresIdentitySecurityTransactionStore {
  constructor(
    private readonly pool: Pool,
    private readonly encryptionKey: Buffer,
    private readonly now: () => Date = () => new Date()
  ) {
    if (!Buffer.isBuffer(encryptionKey) || encryptionKey.length !== 32) {
      throw new TypeError("Invalid identity security transaction encryption key.");
    }
  }

  async createTransaction(
    state: string,
    browserBinding: string,
    userId: string,
    sessionId: string,
    purpose: IdentitySecurityTransactionPurpose,
    payload: IdentitySecurityTransactionPayload,
    expiresAt: Date
  ): Promise<void> {
    const createdAt = this.now();
    if (!validUuid(userId) || !validOpaqueDate(expiresAt) ||
        !isTransactionPurpose(purpose) ||
        expiresAt.getTime() <= createdAt.getTime() ||
        expiresAt.getTime() > createdAt.getTime() + MAX_TRANSACTION_LIFETIME_MS) {
      throw new TypeError("Invalid identity security transaction.");
    }

    let stateHash: Buffer;
    let browserBindingHash: Buffer;
    let sessionIdHash: Buffer;
    let encryptedPayload: Buffer;
    try {
      stateHash = hashOpaqueSecret(state);
      browserBindingHash = hashOpaqueSecret(browserBinding);
      sessionIdHash = hashOpaqueSecret(sessionId);
      encryptedPayload = encryptIdentitySecurityTransactionPayload(payload, this.encryptionKey);
    } catch {
      throw new TypeError("Invalid identity security transaction.");
    }

    try {
      await this.pool.query(
        `INSERT INTO identity_security_transactions
           (state_hash, user_id, session_id_hash, browser_binding_hash,
            purpose, encrypted_payload, created_at, expires_at)
         VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8)`,
        [stateHash, userId, sessionIdHash, browserBindingHash, purpose,
          encryptedPayload, createdAt, expiresAt]
      );
    } catch {
      throw new IdentitySecurityTransactionStoreError();
    }
  }

  async consumeTransaction(
    state: string,
    browserBinding: string,
    userId: string,
    sessionId: string,
    purpose: IdentitySecurityTransactionPurpose
  ): Promise<ConsumedIdentitySecurityTransaction | null> {
    if (!validUuid(userId) || !isTransactionPurpose(purpose)) return null;

    let stateHash: Buffer;
    let browserBindingHash: Buffer;
    let sessionIdHash: Buffer;
    try {
      stateHash = hashOpaqueSecret(state);
      browserBindingHash = hashOpaqueSecret(browserBinding);
      sessionIdHash = hashOpaqueSecret(sessionId);
    } catch {
      return null;
    }

    try {
      const consumedAt = this.now();
      const result = await this.pool.query<{
        transaction_id: string;
        encrypted_payload: Buffer;
      }>(
        `UPDATE identity_security_transactions
            SET consumed_at = $6
          WHERE state_hash = $1
            AND browser_binding_hash = $2
            AND user_id = $3::uuid
            AND session_id_hash = $4
            AND purpose = $5
            AND consumed_at IS NULL
            AND expires_at > $6
          RETURNING transaction_id, encrypted_payload`,
        [stateHash, browserBindingHash, userId, sessionIdHash, purpose, consumedAt]
      );
      const row = result.rows[0];
      if (!row) return null;
      return Object.freeze({
        transactionId: row.transaction_id,
        payload: decryptIdentitySecurityTransactionPayload(row.encrypted_payload, this.encryptionKey)
      });
    } catch {
      throw new IdentitySecurityTransactionStoreError();
    }
  }

  /**
   * Call only after the OIDC callback has cryptographically verified a fresh
   * authentication and confirmed that its active external identity belongs
   * to the same internal user. This method is deliberately not exposed by an
   * HTTP route in B1.
   */
  async issueVerifiedStepUpGrant(
    sourceTransactionId: string,
    userId: string,
    sessionId: string,
    purpose: IdentityStepUpPurpose,
    expiresAt: Date
  ): Promise<string | null> {
    const createdAt = this.now();
    if (!validUuid(sourceTransactionId) || !validUuid(userId) ||
        !isStepUpPurpose(purpose) || !validOpaqueDate(expiresAt) ||
        expiresAt.getTime() <= createdAt.getTime() ||
        expiresAt.getTime() > createdAt.getTime() + MAX_STEP_UP_LIFETIME_MS) {
      throw new TypeError("Invalid identity step-up grant.");
    }

    let sessionIdHash: Buffer;
    let grantHash: Buffer;
    const grant = createOpaqueSessionId();
    try {
      sessionIdHash = hashOpaqueSecret(sessionId);
      grantHash = hashOpaqueSecret(grant);
    } catch {
      throw new TypeError("Invalid identity step-up grant.");
    }

    const transactionPurpose = purpose === "identity_link"
      ? "reauth_identity_link"
      : "reauth_identity_unlink";
    try {
      const result = await this.pool.query(
        `INSERT INTO identity_step_up_grants
           (grant_hash, source_transaction_id, user_id, session_id_hash,
            purpose, created_at, expires_at)
         SELECT $1, transaction_id, user_id, session_id_hash, $5, $6, $7
           FROM identity_security_transactions
          WHERE transaction_id = $2::uuid
            AND user_id = $3::uuid
            AND session_id_hash = $4
            AND purpose = $8
            AND consumed_at IS NOT NULL
            AND consumed_at > $6 - interval '5 minutes'
         ON CONFLICT DO NOTHING`,
        [grantHash, sourceTransactionId, userId, sessionIdHash, purpose,
          createdAt, expiresAt, transactionPurpose]
      );
      return result.rowCount === 1 ? grant : null;
    } catch {
      throw new IdentitySecurityTransactionStoreError();
    }
  }

  async consumeStepUpGrant(
    grant: string,
    userId: string,
    sessionId: string,
    purpose: IdentityStepUpPurpose
  ): Promise<boolean> {
    if (!validUuid(userId) || !isStepUpPurpose(purpose)) return false;
    let grantHash: Buffer;
    let sessionIdHash: Buffer;
    try {
      grantHash = hashOpaqueSecret(grant);
      sessionIdHash = hashOpaqueSecret(sessionId);
    } catch {
      return false;
    }

    try {
      const consumedAt = this.now();
      const result = await this.pool.query(
        `UPDATE identity_step_up_grants
            SET consumed_at = $5
          WHERE grant_hash = $1
            AND user_id = $2::uuid
            AND session_id_hash = $3
            AND purpose = $4
            AND consumed_at IS NULL
            AND expires_at > $5`,
        [grantHash, userId, sessionIdHash, purpose, consumedAt]
      );
      return result.rowCount === 1;
    } catch {
      throw new IdentitySecurityTransactionStoreError();
    }
  }

  async purgeExpired(): Promise<number> {
    try {
      const grants = await this.pool.query(
        `DELETE FROM identity_step_up_grants
          WHERE expires_at <= $1
             OR (consumed_at IS NOT NULL AND consumed_at < $1 - interval '1 day')`,
        [this.now()]
      );
      const transactions = await this.pool.query(
        `DELETE FROM identity_security_transactions AS security_tx
          WHERE (security_tx.expires_at <= $1
             OR (security_tx.consumed_at IS NOT NULL
                 AND security_tx.consumed_at < $1 - interval '1 day'))
            AND NOT EXISTS (
              SELECT 1 FROM identity_step_up_grants AS grant_record
               WHERE grant_record.source_transaction_id = security_tx.transaction_id
            )`,
        [this.now()]
      );
      return (grants.rowCount ?? 0) + (transactions.rowCount ?? 0);
    } catch {
      throw new IdentitySecurityTransactionStoreError();
    }
  }
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function validOpaqueDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function isTransactionPurpose(value: unknown): value is IdentitySecurityTransactionPurpose {
  return value === "reauth_identity_link" || value === "reauth_identity_unlink";
}

function isStepUpPurpose(value: unknown): value is IdentityStepUpPurpose {
  return value === "identity_link" || value === "identity_unlink";
}
