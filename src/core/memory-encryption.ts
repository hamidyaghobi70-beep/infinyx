import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface MemoryKeyProvider {
  getActiveKey(): Promise<{ readonly keyId: string; readonly key: Uint8Array }>;
  getKey(keyId: string): Promise<Uint8Array | null>;
}

/** Canonical storage identity authenticated by v2 envelopes. */
export interface MemoryEncryptionContext {
  readonly tenantId: string;
  readonly namespace: string;
  readonly key: string;
}

export interface EncryptedMemoryEnvelope {
  readonly formatVersion: 1 | 2;
  readonly encryptionVersion: 1 | 2;
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

/**
 * AES-256-GCM envelope encryption. New writes with an identity context use v2
 * and authenticate the tenant/namespace/record key as AAD. Context-free calls
 * remain v1 for compatibility with existing standalone callers and old records.
 */
export class MemoryValueCipher {
  readonly #getActiveKey: MemoryKeyProvider["getActiveKey"];
  readonly #getKey: MemoryKeyProvider["getKey"];

  constructor(keys: MemoryKeyProvider) {
    try {
      const getActiveKey = Reflect.get(keys, "getActiveKey");
      const getKey = Reflect.get(keys, "getKey");
      if (typeof getActiveKey !== "function" || typeof getKey !== "function") throw new TypeError();
      this.#getActiveKey = getActiveKey.bind(keys) as MemoryKeyProvider["getActiveKey"];
      this.#getKey = getKey.bind(keys) as MemoryKeyProvider["getKey"];
      Object.freeze(this);
    } catch {
      throw new TypeError("Memory key provider methods must be readable functions.");
    }
  }

  async encrypt(plaintext: string, context?: MemoryEncryptionContext): Promise<EncryptedMemoryEnvelope> {
    try {
      const active = await this.#getActiveKey();
      assertKey(active.key);
      assertKeyId(active.keyId);
      const nonce = randomBytes(12);
      const version = context === undefined ? 1 : 2;
      const cipher = createCipheriv("aes-256-gcm", Buffer.from(active.key), nonce);
      if (context !== undefined) cipher.setAAD(encodeContext(context));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return Object.freeze({
        formatVersion: version,
        encryptionVersion: version,
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
    const active = await this.#getActiveKey();
    assertKey(active.key);
    try { assertKeyId(active.keyId); } catch (cause) { throw new MemoryEncryptionError(undefined, { cause }); }
    return active.keyId;
  }

  async reencrypt(envelope: EncryptedMemoryEnvelope, context?: MemoryEncryptionContext): Promise<EncryptedMemoryEnvelope> {
    const plaintext = await this.decrypt(envelope, context);
    return this.encrypt(plaintext, context);
  }

  async decrypt(envelope: EncryptedMemoryEnvelope, context?: MemoryEncryptionContext): Promise<string> {
    try {
      if (envelope.algorithm !== "A256GCM" ||
          !((envelope.formatVersion === 1 && envelope.encryptionVersion === 1) ||
            (envelope.formatVersion === 2 && envelope.encryptionVersion === 2))) {
        throw new Error("Unsupported encrypted memory envelope.");
      }
      if (envelope.formatVersion === 2 && context === undefined) {
        throw new Error("Authenticated memory context is required.");
      }
      assertKeyId(envelope.keyId);
      const key = await this.#getKey(envelope.keyId);
      if (!key) throw new Error("Memory decryption key is unavailable.");
      assertKey(key);
      const nonce = decodeCanonicalBase64(envelope.nonce);
      const ciphertext = decodeCanonicalBase64(envelope.ciphertext);
      const tag = decodeCanonicalBase64(envelope.authenticationTag);
      if (nonce.length !== 12 || tag.length !== 16) throw new Error("Malformed encrypted memory envelope.");
      const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key), nonce);
      if (envelope.formatVersion === 2) decipher.setAAD(encodeContext(context!));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch (cause) {
      throw new MemoryEncryptionError(undefined, { cause });
    }
  }
}

function encodeContext(context: MemoryEncryptionContext): Buffer {
  if (!context || typeof context !== "object") throw new Error("Invalid memory encryption context.");
  const { tenantId, namespace, key } = context;
  for (const value of [tenantId, namespace, key]) {
    if (typeof value !== "string" || value.length === 0 || value.length > 512 ||
        value.trim().length === 0 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
      throw new Error("Invalid memory encryption context.");
    }
  }
  // JSON tuple encoding is deterministic and unambiguous (unlike delimiter joining).
  return Buffer.from(JSON.stringify(["infinyx-memory-aad-v2", tenantId, namespace, key]), "utf8");
}

function assertKey(key: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) {
    throw new Error("KMS must provide exactly 256 bits of key material.");
  }
}

function assertKeyId(keyId: unknown): asserts keyId is string {
  if (typeof keyId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(keyId)) {
    throw new Error("Invalid key identifier.");
  }
}

function decodeCanonicalBase64(value: unknown): Buffer {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("Malformed encrypted memory envelope.");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw new Error("Malformed encrypted memory envelope.");
  return decoded;
}
