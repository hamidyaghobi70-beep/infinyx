import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** Key material is supplied by a KMS-backed provider; production keys never belong in PostgreSQL. */
export interface MemoryKeyProvider {
  getActiveKey(): Promise<{ readonly keyId: string; readonly key: Uint8Array }>;
  getKey(keyId: string): Promise<Uint8Array | null>;
}

export interface EncryptedMemoryEnvelope {
  readonly formatVersion: 1;
  readonly encryptionVersion: 1;
  readonly algorithm: "A256GCM";
  readonly keyId: string;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly authenticationTag: string;
}

export class MemoryEncryptionError extends Error {
  constructor(message = "Memory encryption operation failed.", options?: ErrorOptions) {
    super(message, options);
    this.name = "MemoryEncryptionError";
  }
}

/** AES-256-GCM envelope encryption. Key custody and rotation are delegated to MemoryKeyProvider. */
export class MemoryValueCipher {
  constructor(private readonly keys: MemoryKeyProvider) {}

  async encrypt(plaintext: string): Promise<EncryptedMemoryEnvelope> {
    try {
      const active = await this.keys.getActiveKey();
      assertKey(active.key);
      if (!active.keyId || active.keyId.length > 128) throw new Error("Invalid key identifier.");
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", active.key, nonce);
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return Object.freeze({
        formatVersion: 1,
        encryptionVersion: 1,
        algorithm: "A256GCM",
        keyId: active.keyId,
        nonce: nonce.toString("base64"),
        ciphertext: ciphertext.toString("base64"),
        authenticationTag: cipher.getAuthTag().toString("base64")
      });
    } catch (cause) {
      throw new MemoryEncryptionError(undefined, { cause });
    }
  }

  async activeKeyId(): Promise<string> {
    const active = await this.keys.getActiveKey();
    assertKey(active.key);
    if (!active.keyId || active.keyId.length > 128) throw new MemoryEncryptionError();
    return active.keyId;
  }

  /** Re-encrypts plaintext with the provider's current active key; never exports plaintext. */
  async reencrypt(envelope: EncryptedMemoryEnvelope): Promise<EncryptedMemoryEnvelope> {
    const plaintext = await this.decrypt(envelope);
    return this.encrypt(plaintext);
  }

  async decrypt(envelope: EncryptedMemoryEnvelope): Promise<string> {
    try {
      if (envelope.formatVersion !== 1 || envelope.encryptionVersion !== 1 || envelope.algorithm !== "A256GCM") {
        throw new Error("Unsupported encrypted memory envelope.");
      }
      const key = await this.keys.getKey(envelope.keyId);
      if (!key) throw new Error("Memory decryption key is unavailable.");
      assertKey(key);
      const nonce = Buffer.from(envelope.nonce, "base64");
      const ciphertext = Buffer.from(envelope.ciphertext, "base64");
      const tag = Buffer.from(envelope.authenticationTag, "base64");
      if (nonce.length !== 12 || tag.length !== 16) throw new Error("Malformed encrypted memory envelope.");
      const decipher = createDecipheriv("aes-256-gcm", key, nonce);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch (cause) {
      throw new MemoryEncryptionError(undefined, { cause });
    }
  }
}

function assertKey(key: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) {
    throw new Error("KMS must provide exactly 256 bits of key material.");
  }
}
