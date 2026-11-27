import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type InvitationIdentityType = "email" | "phone";

export interface InvitationKeyMaterial {
  readonly tokenKey: Buffer;
  readonly tokenKeyVersion: number;
  readonly identityKey: Buffer;
  readonly identityKeyVersion: number;
  readonly deliveryKey: Buffer;
  readonly deliveryKeyVersion: number;
}

export interface InvitationSecrets {
  readonly rawToken: string;
  readonly tokenHash: Buffer;
  readonly identityFingerprint: Buffer;
  readonly identityType: InvitationIdentityType;
  readonly normalizedIdentity: string;
}

export class InvitationInputError extends Error {
  constructor() {
    super("Invalid invitation input.");
    this.name = "InvitationInputError";
  }
}

function assertKeyMaterial(keys: InvitationKeyMaterial): void {
  if (
    !Buffer.isBuffer(keys.tokenKey) || keys.tokenKey.length < 32 ||
    !Buffer.isBuffer(keys.identityKey) || keys.identityKey.length < 32 ||
    !Buffer.isBuffer(keys.deliveryKey) || keys.deliveryKey.length !== 32 ||
    !Number.isSafeInteger(keys.deliveryKeyVersion) || keys.deliveryKeyVersion < 1 ||
    !Number.isSafeInteger(keys.tokenKeyVersion) || keys.tokenKeyVersion < 1 ||
    !Number.isSafeInteger(keys.identityKeyVersion) || keys.identityKeyVersion < 1
  ) {
    throw new TypeError("Invitation key material is unavailable.");
  }
}

/**
 * Email is normalized conservatively. Phone values must already be E.164;
 * the platform never guesses a country code from locale or IP.
 */
export function normalizeInvitationIdentity(
  type: InvitationIdentityType,
  value: string
): string {
  if (typeof value !== "string" || value.length > 512) {
    throw new InvitationInputError();
  }

  const normalized = value.normalize("NFC").trim();
  if (!normalized || /[\u0000-\u001f\u007f-\u009f]/.test(normalized)) {
    throw new InvitationInputError();
  }

  if (type === "email") {
    const email = normalized.toLowerCase();
    if (
      email.length > 320 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      throw new InvitationInputError();
    }
    return email;
  }

  if (type === "phone" && /^\+[1-9][0-9]{7,14}$/.test(normalized)) {
    return normalized;
  }

  throw new InvitationInputError();
}

function hmac(key: Buffer, purpose: string, value: string): Buffer {
  return createHmac("sha256", key)
    .update(purpose, "utf8")
    .update("\0", "utf8")
    .update(value, "utf8")
    .digest();
}

export function createInvitationSecrets(
  type: InvitationIdentityType,
  identity: string,
  keys: InvitationKeyMaterial
): InvitationSecrets {
  assertKeyMaterial(keys);
  const normalizedIdentity = normalizeInvitationIdentity(type, identity);
  const rawToken = randomBytes(32).toString("base64url");
  return Object.freeze({
    rawToken,
    tokenHash: hmac(keys.tokenKey, "infinyx-invitation-token-v1", rawToken),
    identityFingerprint: hmac(
      keys.identityKey,
      `infinyx-invitation-identity-v1:${type}`,
      normalizedIdentity
    ),
    identityType: type,
    normalizedIdentity
  });
}

export function hashInvitationToken(
  token: string,
  tokenKey: Buffer
): Buffer {
  if (!Buffer.isBuffer(tokenKey) || tokenKey.length < 32 ||
      typeof token !== "string" || !/^[A-Za-z0-9_-]{40,64}$/.test(token)) {
    throw new InvitationInputError();
  }
  return hmac(tokenKey, "infinyx-invitation-token-v1", token);
}

export function invitationTokenMatches(
  candidate: Buffer,
  stored: Buffer
): boolean {
  return Buffer.isBuffer(candidate) && Buffer.isBuffer(stored) &&
    candidate.length === 32 && stored.length === 32 &&
    timingSafeEqual(candidate, stored);
}


export interface EncryptedInvitationDelivery {
  readonly keyVersion: number;
  readonly nonce: Buffer;
  readonly ciphertext: Buffer;
  readonly authTag: Buffer;
}

export interface InvitationDeliveryPayload {
  readonly invitationId: string;
  readonly tenantId: string;
  readonly identityType: InvitationIdentityType;
  readonly normalizedIdentity: string;
  readonly rawToken: string;
}

export function encryptInvitationDelivery(
  payload: InvitationDeliveryPayload,
  keys: InvitationKeyMaterial
): EncryptedInvitationDelivery {
  assertKeyMaterial(keys);
  const nonce = randomBytes(12);
  const aad = Buffer.from(
    `infinyx-invitation-delivery-v1:${payload.tenantId}:${payload.invitationId}:${keys.deliveryKeyVersion}`,
    "utf8"
  );
  const cipher = createCipheriv("aes-256-gcm", keys.deliveryKey, nonce);
  cipher.setAAD(aad);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Object.freeze({
    keyVersion: keys.deliveryKeyVersion,
    nonce,
    ciphertext,
    authTag: cipher.getAuthTag()
  });
}

export function decryptInvitationDelivery(
  encrypted: EncryptedInvitationDelivery,
  tenantId: string,
  invitationId: string,
  deliveryKey: Buffer
): InvitationDeliveryPayload {
  if (
    !Buffer.isBuffer(deliveryKey) || deliveryKey.length !== 32 ||
    !Number.isSafeInteger(encrypted.keyVersion) || encrypted.keyVersion < 1 ||
    !Buffer.isBuffer(encrypted.nonce) || encrypted.nonce.length !== 12 ||
    !Buffer.isBuffer(encrypted.authTag) || encrypted.authTag.length !== 16 ||
    !Buffer.isBuffer(encrypted.ciphertext)
  ) {
    throw new InvitationInputError();
  }
  try {
    const aad = Buffer.from(
      `infinyx-invitation-delivery-v1:${tenantId}:${invitationId}:${encrypted.keyVersion}`,
      "utf8"
    );
    const decipher = createDecipheriv("aes-256-gcm", deliveryKey, encrypted.nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(encrypted.authTag);
    const plaintext = Buffer.concat([
      decipher.update(encrypted.ciphertext),
      decipher.final()
    ]);
    const parsed: unknown = JSON.parse(plaintext.toString("utf8"));
    if (
      !parsed || typeof parsed !== "object" ||
      (parsed as Record<string, unknown>).tenantId !== tenantId ||
      (parsed as Record<string, unknown>).invitationId !== invitationId
    ) {
      throw new Error();
    }
    const value = parsed as InvitationDeliveryPayload;
    if (
      (value.identityType !== "email" && value.identityType !== "phone") ||
      typeof value.normalizedIdentity !== "string" ||
      typeof value.rawToken !== "string"
    ) {
      throw new Error();
    }
    return Object.freeze(value);
  } catch {
    throw new InvitationInputError();
  }
}
