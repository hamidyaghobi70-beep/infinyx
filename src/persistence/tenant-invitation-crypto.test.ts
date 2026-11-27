import { describe, expect, it } from "vitest";
import {
  createInvitationSecrets,
  decryptInvitationDelivery,
  encryptInvitationDelivery,
  hashInvitationToken,
  invitationTokenMatches,
  normalizeInvitationIdentity,
  type InvitationKeyMaterial
} from "./tenant-invitation-crypto.js";

const keys: InvitationKeyMaterial = {
  tokenKey: Buffer.alloc(32, 7),
  tokenKeyVersion: 1,
  identityKey: Buffer.alloc(32, 9),
  identityKeyVersion: 1,
  deliveryKey: Buffer.alloc(32, 11),
  deliveryKeyVersion: 1
};

describe("tenant invitation cryptographic primitives", () => {
  it("normalizes email without storing it in the fingerprint", () => {
    expect(normalizeInvitationIdentity("email", "  OWNER@Example.COM "))
      .toBe("owner@example.com");
    const a = createInvitationSecrets("email", "OWNER@example.com", keys);
    const b = createInvitationSecrets("email", " owner@example.com ", keys);
    expect(a.identityFingerprint).toEqual(b.identityFingerprint);
    expect(a.tokenHash).not.toEqual(b.tokenHash);
    expect(a.rawToken).not.toBe(a.normalizedIdentity);
  });

  it("accepts only explicit E.164 phone values", () => {
    expect(normalizeInvitationIdentity("phone", "+989121234567"))
      .toBe("+989121234567");
    expect(() => normalizeInvitationIdentity("phone", "09121234567"))
      .toThrow();
  });

  it("uses a keyed token hash and constant-time candidate comparison", () => {
    const invitation = createInvitationSecrets("email", "person@example.com", keys);
    const candidate = hashInvitationToken(invitation.rawToken, keys.tokenKey);
    expect(candidate).toEqual(invitation.tokenHash);
    expect(invitationTokenMatches(candidate, invitation.tokenHash)).toBe(true);
    expect(invitationTokenMatches(Buffer.alloc(32), invitation.tokenHash)).toBe(false);
  });

  it("rejects weak or missing key material", () => {
    expect(() => createInvitationSecrets("email", "person@example.com", {
      ...keys,
      tokenKey: Buffer.alloc(16)
    })).toThrow();
  });

  it("rejects malformed identities and tokens", () => {
    expect(() => normalizeInvitationIdentity("email", "not-an-email")).toThrow();
    expect(() => hashInvitationToken("short", keys.tokenKey)).toThrow();
  });
});

  it("encrypts outbox payloads and binds ciphertext to tenant and invitation", () => {
    const encrypted = encryptInvitationDelivery({
      invitationId: "00000000-0000-4000-8000-000000000001",
      tenantId: "tenant-a",
      identityType: "email",
      normalizedIdentity: "person@example.com",
      rawToken: "a".repeat(43)
    }, keys);

    expect(encrypted.ciphertext.toString("utf8")).not.toContain("person@example.com");
    expect(decryptInvitationDelivery(
      encrypted,
      "tenant-a",
      "00000000-0000-4000-8000-000000000001",
      keys.deliveryKey
    )).toMatchObject({
      tenantId: "tenant-a",
      identityType: "email",
      normalizedIdentity: "person@example.com"
    });
    expect(() => decryptInvitationDelivery(
      encrypted,
      "tenant-b",
      "00000000-0000-4000-8000-000000000001",
      keys.deliveryKey
    )).toThrow();
  });
