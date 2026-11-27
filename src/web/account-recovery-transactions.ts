import type { Pool } from "pg";
import {
  decryptAccountRecoveryTransactionPayload,
  encryptAccountRecoveryTransactionPayload,
  hashOpaqueSecret,
  type IdentitySecurityTransactionPayload
} from "./session-crypto.js";

const MAX_LIFETIME_MS = 5 * 60 * 1000;

export class AccountRecoveryTransactionStoreError extends Error {
  constructor() {
    super("Account recovery transaction operation failed.");
    this.name = "AccountRecoveryTransactionStoreError";
  }
}

export interface ConsumedAccountRecoveryTransaction {
  readonly transactionId: string;
  readonly payload: IdentitySecurityTransactionPayload;
}

export class PostgresAccountRecoveryTransactionStore {
  constructor(
    private readonly pool: Pool,
    private readonly encryptionKey: Buffer,
    private readonly now: () => Date = () => new Date()
  ) {
    if (!Buffer.isBuffer(encryptionKey) || encryptionKey.length !== 32) {
      throw new TypeError("Invalid account recovery encryption key.");
    }
  }

  async create(
    state: string,
    browserBinding: string,
    payload: IdentitySecurityTransactionPayload,
    expiresAt: Date
  ): Promise<void> {
    const createdAt = this.now();
    if (!(expiresAt instanceof Date) || !Number.isFinite(expiresAt.getTime()) ||
        expiresAt.getTime() <= createdAt.getTime() ||
        expiresAt.getTime() > createdAt.getTime() + MAX_LIFETIME_MS) {
      throw new TypeError("Invalid account recovery transaction.");
    }

    let stateHash: Buffer;
    let browserBindingHash: Buffer;
    let encryptedPayload: Buffer;
    try {
      stateHash = hashOpaqueSecret(state);
      browserBindingHash = hashOpaqueSecret(browserBinding);
      encryptedPayload = encryptAccountRecoveryTransactionPayload(payload, this.encryptionKey);
    } catch {
      throw new TypeError("Invalid account recovery transaction.");
    }

    try {
      await this.pool.query(
        `INSERT INTO user_account_recovery_transactions
           (state_hash, browser_binding_hash, encrypted_payload, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [stateHash, browserBindingHash, encryptedPayload, createdAt, expiresAt]
      );
    } catch {
      throw new AccountRecoveryTransactionStoreError();
    }
  }

  async consume(
    state: string,
    browserBinding: string
  ): Promise<ConsumedAccountRecoveryTransaction | null> {
    let stateHash: Buffer;
    let browserBindingHash: Buffer;
    try {
      stateHash = hashOpaqueSecret(state);
      browserBindingHash = hashOpaqueSecret(browserBinding);
    } catch {
      return null;
    }

    try {
      const consumedAt = this.now();
      const result = await this.pool.query<{
        transaction_id: string;
        encrypted_payload: Buffer;
      }>(
        `UPDATE user_account_recovery_transactions
            SET consumed_at = $3
          WHERE state_hash = $1
            AND browser_binding_hash = $2
            AND consumed_at IS NULL
            AND expires_at > $3
          RETURNING transaction_id, encrypted_payload`,
        [stateHash, browserBindingHash, consumedAt]
      );
      const row = result.rows[0];
      if (!row) return null;
      return Object.freeze({
        transactionId: row.transaction_id,
        payload: decryptAccountRecoveryTransactionPayload(row.encrypted_payload, this.encryptionKey)
      });
    } catch {
      throw new AccountRecoveryTransactionStoreError();
    }
  }
}
