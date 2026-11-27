import { describe, expect, it } from "vitest";
import {
  createCsrfToken,
  createOpaqueSessionId,
  decryptSessionTokenBundle,
  decodeSessionEncryptionKey,
  encryptSessionTokenBundle,
  hashCsrfToken,
  hashOpaqueSecret,
  verifyCsrfToken
} from "./session-crypto.js";

const key = Buffer.alloc(32, 7);

describe("web session cryptography", () => {
  it("creates opaque 256-bit session and CSRF secrets", () => {
    const sessionId = createOpaqueSessionId();
    const csrf = createCsrfToken();
    expect(sessionId).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(csrf).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(hashOpaqueSecret(sessionId)).toHaveLength(32);
    expect(hashCsrfToken(csrf)).toHaveLength(32);
  });

  it("encrypts and decrypts token bundles with authenticated encryption", () => {
    const bundle = {
      accessToken: "synthetic-access-token",
      refreshToken: "synthetic-refresh-token",
      accessTokenExpiresAt: 1_900_000_000
    };
    const encrypted = encryptSessionTokenBundle(bundle, key);
    expect(decryptSessionTokenBundle(encrypted, key)).toEqual(bundle);
    expect(encrypted.includes(Buffer.from(bundle.accessToken))).toBe(false);
  });

  it("rejects tampered ciphertext and wrong keys", () => {
    const encrypted = encryptSessionTokenBundle({
      accessToken: "synthetic-token",
      accessTokenExpiresAt: 1_900_000_000
    }, key);
    const tampered = Buffer.from(encrypted);
    tampered[tampered.length - 1] ^= 1;
    expect(() => decryptSessionTokenBundle(tampered, key)).toThrow();
    expect(() => decryptSessionTokenBundle(encrypted, Buffer.alloc(32, 8))).toThrow();
  });

  it("validates CSRF secrets using constant-time digest comparison", () => {
    const token = createCsrfToken();
    expect(verifyCsrfToken(token, hashCsrfToken(token))).toBe(true);
    expect(verifyCsrfToken(createCsrfToken(), hashCsrfToken(token))).toBe(false);
    expect(verifyCsrfToken(token, Buffer.alloc(31))).toBe(false);
  });

  it("rejects invalid encryption key configuration", () => {
    expect(() => decodeSessionEncryptionKey(undefined)).toThrow();
    expect(() => decodeSessionEncryptionKey("invalid")).toThrow();
  });
});
