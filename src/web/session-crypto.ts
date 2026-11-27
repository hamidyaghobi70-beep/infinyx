import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

const SESSION_ID_BYTES = 32;
const ENCRYPTION_KEY_BYTES = 32;
const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;
const MAX_TOKEN_BUNDLE_BYTES = 32 * 1024;

export class SessionCryptoError extends Error {
  constructor() {
    super("Session cryptographic operation failed.");
    this.name = "SessionCryptoError";
  }
}

export interface SessionTokenBundle {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly accessTokenExpiresAt: number;
  readonly csrfToken?: string;
}

export function createOpaqueSessionId(): string {
  return randomBytes(SESSION_ID_BYTES).toString("base64url");
}

export function createCsrfToken(): string {
  return randomBytes(SESSION_ID_BYTES).toString("base64url");
}

function decodeOpaqueSecret(value: string): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new SessionCryptoError();
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== SESSION_ID_BYTES || decoded.toString("base64url") !== value) throw new SessionCryptoError();
  return decoded;
}

export function hashOpaqueSecret(value: string): Buffer {
  return createHash("sha256").update(decodeOpaqueSecret(value)).digest();
}

export function hashCsrfToken(value: string): Buffer {
  return createHash("sha256").update(decodeOpaqueSecret(value)).digest();
}

export function verifyCsrfToken(value: string, expectedHash: Buffer): boolean {
  if (!Buffer.isBuffer(expectedHash) || expectedHash.length !== 32) return false;
  try {
    const actual = hashCsrfToken(value);
    return timingSafeEqual(actual, expectedHash);
  } catch {
    return false;
  }
}

export function decodeSessionEncryptionKey(value: string | undefined): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{43}=$/u.test(value)) {
    throw new SessionCryptoError();
  }
  const key = Buffer.from(value, "base64");
  if (key.length !== ENCRYPTION_KEY_BYTES || key.toString("base64") !== value) throw new SessionCryptoError();
  return key;
}

export function encryptSessionTokenBundle(
  bundle: SessionTokenBundle,
  key: Buffer
): Buffer {
  if (!Buffer.isBuffer(key) || key.length !== ENCRYPTION_KEY_BYTES ||
      !isValidTokenBundle(bundle)) throw new SessionCryptoError();
  try {
    const nonce = randomBytes(GCM_NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from("infinyx:web-session:v1", "utf8"));
    const plaintext = Buffer.from(JSON.stringify(bundle), "utf8");
    if (plaintext.length > MAX_TOKEN_BUNDLE_BYTES) throw new SessionCryptoError();
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), ciphertext]);
  } catch {
    throw new SessionCryptoError();
  }
}

export function decryptSessionTokenBundle(
  encrypted: Buffer,
  key: Buffer
): SessionTokenBundle {
  if (!Buffer.isBuffer(encrypted) || encrypted.length < 1 + GCM_NONCE_BYTES + GCM_TAG_BYTES ||
      encrypted.length > MAX_TOKEN_BUNDLE_BYTES + 1 + GCM_NONCE_BYTES + GCM_TAG_BYTES ||
      encrypted[0] !== 1 || !Buffer.isBuffer(key) || key.length !== ENCRYPTION_KEY_BYTES) {
    throw new SessionCryptoError();
  }
  try {
    const nonce = encrypted.subarray(1, 1 + GCM_NONCE_BYTES);
    const tagStart = 1 + GCM_NONCE_BYTES;
    const tag = encrypted.subarray(tagStart, tagStart + GCM_TAG_BYTES);
    const ciphertext = encrypted.subarray(tagStart + GCM_TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(Buffer.from("infinyx:web-session:v1", "utf8"));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const parsed: unknown = JSON.parse(plaintext.toString("utf8"));
    if (!isValidTokenBundle(parsed)) throw new SessionCryptoError();
    return Object.freeze({
      accessToken: parsed.accessToken,
      ...(parsed.refreshToken === undefined ? {} : { refreshToken: parsed.refreshToken }),
      accessTokenExpiresAt: parsed.accessTokenExpiresAt,
      ...(parsed.csrfToken === undefined ? {} : { csrfToken: parsed.csrfToken })
    });
  } catch {
    throw new SessionCryptoError();
  }
}

function isValidTokenBundle(value: unknown): value is SessionTokenBundle {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.accessToken === "string" &&
    item.accessToken.length > 0 && item.accessToken.length <= 16_384 &&
    (item.refreshToken === undefined ||
      (typeof item.refreshToken === "string" && item.refreshToken.length > 0 && item.refreshToken.length <= 16_384)) &&
    typeof item.accessTokenExpiresAt === "number" &&
    Number.isSafeInteger(item.accessTokenExpiresAt) && item.accessTokenExpiresAt > 0 &&
    (item.csrfToken === undefined ||
      (typeof item.csrfToken === "string" && /^[A-Za-z0-9_-]{43}$/u.test(item.csrfToken)));
}

export interface OidcLoginPayload {
  readonly codeVerifier: string;
  readonly nonce: string;
}

export function encryptOidcLoginPayload(payload: OidcLoginPayload, key: Buffer): Buffer {
  if (!Buffer.isBuffer(key) || key.length !== ENCRYPTION_KEY_BYTES ||
      !isValidOidcLoginPayload(payload)) throw new SessionCryptoError();
  try {
    const nonce = randomBytes(GCM_NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from("infinyx:oidc-login-transaction:v1", "utf8"));
    const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
    if (plaintext.length > 4096) throw new SessionCryptoError();
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), ciphertext]);
  } catch {
    throw new SessionCryptoError();
  }
}

export function decryptOidcLoginPayload(encrypted: Buffer, key: Buffer): OidcLoginPayload {
  if (!Buffer.isBuffer(encrypted) || encrypted.length < 1 + GCM_NONCE_BYTES + GCM_TAG_BYTES ||
      encrypted.length > 4096 + 1 + GCM_NONCE_BYTES + GCM_TAG_BYTES ||
      encrypted[0] !== 1 || !Buffer.isBuffer(key) || key.length !== ENCRYPTION_KEY_BYTES) {
    throw new SessionCryptoError();
  }
  try {
    const nonce = encrypted.subarray(1, 1 + GCM_NONCE_BYTES);
    const tagStart = 1 + GCM_NONCE_BYTES;
    const tag = encrypted.subarray(tagStart, tagStart + GCM_TAG_BYTES);
    const ciphertext = encrypted.subarray(tagStart + GCM_TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(Buffer.from("infinyx:oidc-login-transaction:v1", "utf8"));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const parsed: unknown = JSON.parse(plaintext.toString("utf8"));
    if (!isValidOidcLoginPayload(parsed)) throw new SessionCryptoError();
    return Object.freeze({ codeVerifier: parsed.codeVerifier, nonce: parsed.nonce });
  } catch {
    throw new SessionCryptoError();
  }
}

function isValidOidcLoginPayload(value: unknown): value is OidcLoginPayload {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.codeVerifier === "string" &&
    /^[A-Za-z0-9._~-]{43,128}$/u.test(item.codeVerifier) &&
    typeof item.nonce === "string" &&
    /^[A-Za-z0-9_-]{43}$/u.test(item.nonce);
}


export interface IdentitySecurityTransactionPayload {
  readonly codeVerifier: string;
  readonly nonce: string;
}

export function encryptIdentitySecurityTransactionPayload(
  payload: IdentitySecurityTransactionPayload,
  key: Buffer
): Buffer {
  if (!Buffer.isBuffer(key) || key.length !== ENCRYPTION_KEY_BYTES ||
      !isValidIdentitySecurityTransactionPayload(payload)) throw new SessionCryptoError();
  try {
    const nonce = randomBytes(GCM_NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from("infinyx:identity-security-transaction:v1", "utf8"));
    const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
    if (plaintext.length > 4096) throw new SessionCryptoError();
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), ciphertext]);
  } catch {
    throw new SessionCryptoError();
  }
}

export function decryptIdentitySecurityTransactionPayload(
  encrypted: Buffer,
  key: Buffer
): IdentitySecurityTransactionPayload {
  if (!Buffer.isBuffer(encrypted) || encrypted.length < 1 + GCM_NONCE_BYTES + GCM_TAG_BYTES ||
      encrypted.length > 4096 + 1 + GCM_NONCE_BYTES + GCM_TAG_BYTES ||
      encrypted[0] !== 1 || !Buffer.isBuffer(key) || key.length !== ENCRYPTION_KEY_BYTES) {
    throw new SessionCryptoError();
  }
  try {
    const nonce = encrypted.subarray(1, 1 + GCM_NONCE_BYTES);
    const tagStart = 1 + GCM_NONCE_BYTES;
    const tag = encrypted.subarray(tagStart, tagStart + GCM_TAG_BYTES);
    const ciphertext = encrypted.subarray(tagStart + GCM_TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(Buffer.from("infinyx:identity-security-transaction:v1", "utf8"));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const parsed: unknown = JSON.parse(plaintext.toString("utf8"));
    if (!isValidIdentitySecurityTransactionPayload(parsed)) throw new SessionCryptoError();
    return Object.freeze({ codeVerifier: parsed.codeVerifier, nonce: parsed.nonce });
  } catch {
    throw new SessionCryptoError();
  }
}

function isValidIdentitySecurityTransactionPayload(
  value: unknown
): value is IdentitySecurityTransactionPayload {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.codeVerifier === "string" &&
    /^[A-Za-z0-9._~-]{43,128}$/u.test(item.codeVerifier) &&
    typeof item.nonce === "string" &&
    /^[A-Za-z0-9_-]{43}$/u.test(item.nonce);
}
