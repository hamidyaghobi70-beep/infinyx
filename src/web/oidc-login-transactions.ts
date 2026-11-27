import type { Pool } from "pg";
import {
  decryptOidcLoginPayload,
  encryptOidcLoginPayload,
  hashOpaqueSecret,
  type OidcLoginPayload
} from "./session-crypto.js";

export class OidcLoginTransactionStoreError extends Error {
  constructor() {
    super("OIDC login transaction operation failed.");
    this.name = "OidcLoginTransactionStoreError";
  }
}

export interface ConsumedOidcLoginTransaction extends OidcLoginPayload {}

export class PostgresOidcLoginTransactionStore {
  constructor(
    private readonly pool: Pool,
    private readonly encryptionKey: Buffer,
    private readonly now: () => Date = () => new Date()
  ) {
    if (!Buffer.isBuffer(encryptionKey) || encryptionKey.length !== 32) {
      throw new TypeError("Invalid OIDC transaction encryption key.");
    }
  }

  async create(
    state: string,
    browserBinding: string,
    payload: OidcLoginPayload,
    expiresAt: Date
  ): Promise<void> {
    if (!validDate(expiresAt) || expiresAt <= this.now() ||
        expiresAt.getTime() > this.now().getTime() + 10 * 60 * 1000) {
      throw new TypeError("Invalid OIDC transaction expiry.");
    }
    let stateHash: Buffer;
    let bindingHash: Buffer;
    let encrypted: Buffer;
    try {
      stateHash = hashOpaqueSecret(state);
      bindingHash = hashOpaqueSecret(browserBinding);
      encrypted = encryptOidcLoginPayload(payload, this.encryptionKey);
    } catch {
      throw new TypeError("Invalid OIDC login transaction.");
    }
    try {
      await this.pool.query(
        `INSERT INTO web_login_transactions
           (state_hash, browser_binding_hash, encrypted_transaction, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [stateHash, bindingHash, encrypted, expiresAt]
      );
    } catch {
      throw new OidcLoginTransactionStoreError();
    }
  }

  async consume(
    state: string,
    browserBinding: string
  ): Promise<ConsumedOidcLoginTransaction | null> {
    let stateHash: Buffer;
    let bindingHash: Buffer;
    try {
      stateHash = hashOpaqueSecret(state);
      bindingHash = hashOpaqueSecret(browserBinding);
    } catch {
      return null;
    }
    try {
      const result = await this.pool.query<{ encrypted_transaction: Buffer }>(
        `UPDATE web_login_transactions
            SET consumed_at = $3
          WHERE state_hash = $1
            AND browser_binding_hash = $2
            AND consumed_at IS NULL
            AND expires_at > $3
          RETURNING encrypted_transaction`,
        [stateHash, bindingHash, this.now()]
      );
      const row = result.rows[0];
      if (!row) return null;
      return decryptOidcLoginPayload(row.encrypted_transaction, this.encryptionKey);
    } catch {
      throw new OidcLoginTransactionStoreError();
    }
  }

  async purgeExpired(): Promise<number> {
    try {
      const result = await this.pool.query(
        `DELETE FROM web_login_transactions
          WHERE expires_at <= $1
             OR (consumed_at IS NOT NULL AND consumed_at < $1 - interval '1 day')`,
        [this.now()]
      );
      return result.rowCount ?? 0;
    } catch {
      throw new OidcLoginTransactionStoreError();
    }
  }
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}
