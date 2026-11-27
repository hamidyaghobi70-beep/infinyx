import { describe, expect, it } from "vitest";
import {
  decryptOidcLoginPayload,
  encryptOidcLoginPayload,
  decryptIdentitySecurityTransactionPayload,
  encryptIdentitySecurityTransactionPayload,
  createOpaqueSessionId
} from "./session-crypto.js";

const key = Buffer.alloc(32, 11);

describe("OIDC login transaction encryption", () => {
  it("round-trips the PKCE verifier and nonce", () => {
    const payload = {
      codeVerifier: createOpaqueSessionId(),
      nonce: createOpaqueSessionId()
    };
    expect(decryptOidcLoginPayload(encryptOidcLoginPayload(payload, key), key)).toEqual(payload);
  });

  it("rejects tampered encrypted login transactions", () => {
    const encrypted = encryptOidcLoginPayload({
      codeVerifier: createOpaqueSessionId(),
      nonce: createOpaqueSessionId()
    }, key);
    const tampered = Buffer.from(encrypted);
    tampered[tampered.length - 1] ^= 1;
    expect(() => decryptOidcLoginPayload(tampered, key)).toThrow();
  });

  it("rejects invalid verifier and nonce inputs", () => {
    expect(() => encryptOidcLoginPayload({
      codeVerifier: "too-short",
      nonce: createOpaqueSessionId()
    }, key)).toThrow();
    expect(() => encryptOidcLoginPayload({
      codeVerifier: createOpaqueSessionId(),
      nonce: "invalid"
    }, key)).toThrow();
  });
});


describe("identity security transaction encryption", () => {
  it("round-trips the callback payload using a separate authenticated encryption domain", () => {
    const payload = {
      codeVerifier: createOpaqueSessionId(),
      nonce: createOpaqueSessionId()
    };
    const encrypted = encryptIdentitySecurityTransactionPayload(payload, key);
    expect(decryptIdentitySecurityTransactionPayload(encrypted, key)).toEqual(payload);
    expect(() => decryptOidcLoginPayload(encrypted, key)).toThrow();
  });

  it("rejects tampered or invalid identity security transaction payloads", () => {
    const encrypted = encryptIdentitySecurityTransactionPayload({
      codeVerifier: createOpaqueSessionId(),
      nonce: createOpaqueSessionId()
    }, key);
    const tampered = Buffer.from(encrypted);
    tampered[tampered.length - 1] ^= 1;
    expect(() => decryptIdentitySecurityTransactionPayload(tampered, key)).toThrow();
    expect(() => encryptIdentitySecurityTransactionPayload({
      codeVerifier: "invalid",
      nonce: createOpaqueSessionId()
    }, key)).toThrow();
  });
});
