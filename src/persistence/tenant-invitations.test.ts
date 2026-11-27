import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createJwtPrincipalVerifier } from "../core/authenticated-principal.js";
import {
  createTenantInvitation,
  InvitationConflictError,
  InvitationIntegrationUnavailableError,
  resolveInvitationTarget
} from "./tenant-invitations.js";
import type { TenantTransaction } from "./tenant-transaction.js";
import type { InvitationKeyMaterial } from "./tenant-invitation-crypto.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const verifier = createJwtPrincipalVerifier({
  issuer: "https://infinyx.invitation.test",
  audience: "infinyx-test",
  publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString()
});
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const unsigned = [
  encode({ alg: "RS256", typ: "JWT" }),
  encode({
    iss: "https://infinyx.invitation.test",
    aud: "infinyx-test",
    sub: "owner-user",
    tenant_id: "tenant-a",
    exp: Math.floor(Date.now() / 1000) + 600
  })
].join(".");
const principal = verifier(
  unsigned + "." + sign("RSA-SHA256", Buffer.from(unsigned, "ascii"), privateKey).toString("base64url")
);

const keys: InvitationKeyMaterial = {
  tokenKey: Buffer.alloc(32, 3),
  tokenKeyVersion: 1,
  identityKey: Buffer.alloc(32, 5),
  identityKeyVersion: 1,
  deliveryKey: Buffer.alloc(32, 7),
  deliveryKeyVersion: 1
};

function fakeTransaction(options: { targetAlreadyMember?: boolean } = {}) {
  const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  const tx: TenantTransaction = {
    async query<Row = Record<string, unknown>>(
      sql: string,
      values: readonly unknown[] = []
    ): Promise<readonly Row[]> {
      calls.push({ sql, values });
      if (sql.includes("SELECT id FROM tenants")) {
        return [{ id: "tenant-a" }] as unknown as readonly Row[];
      }
      if (sql.includes("generation, role, status, version")) {
        return [{
          membership_id: "00000000-0000-4000-8000-000000000001",
          generation: 1,
          role: "owner",
          status: "active",
          version: "1"
        }] as unknown as readonly Row[];
      }
      if (sql.includes("AND status IN ('active', 'suspended')")) {
        return (options.targetAlreadyMember ? [{ membership_id: "existing" }] : []) as unknown as readonly Row[];
      }
      if (sql.includes("expires_at <= now()")) return [] as unknown as readonly Row[];
      if (sql.includes("expires_at > now()")) return [] as unknown as readonly Row[];
      if (sql.includes("INSERT INTO tenant_invitations")) {
        return [{
          invitation_id: "00000000-0000-4000-8000-000000000002",
          expires_at: "2026-11-30 12:00:00+00"
        }] as unknown as readonly Row[];
      }
      return [] as unknown as readonly Row[];
    }
  };
  return { tx, calls };
}

describe("tenant invitation creation", () => {
  it("fails closed when no trusted identity directory is configured", async () => {
    await expect(resolveInvitationTarget("email", "person@example.com", null))
      .rejects.toBeInstanceOf(InvitationIntegrationUnavailableError);
  });

  it("resolves and normalizes identity through the injected directory", async () => {
    const target = await resolveInvitationTarget("email", " Person@Example.com ", {
      async resolveAccountSubject(type, identity) {
        expect(type).toBe("email");
        expect(identity).toBe("person@example.com");
        return null;
      }
    });
    expect(target).toMatchObject({
      identityType: "email",
      normalizedIdentity: "person@example.com",
      accountSubject: null
    });
  });

  it("stores only hashes and encrypted delivery data and returns no raw token", async () => {
    const target = await resolveInvitationTarget("email", "person@example.com", {
      async resolveAccountSubject() { return null; }
    });
    const { tx, calls } = fakeTransaction();
    const result = await createTenantInvitation(
      tx,
      principal,
      target,
      "viewer",
      "10000000-0000-4000-8000-000000000001",
      keys
    );

    expect(result).toEqual({
      invitationId: "00000000-0000-4000-8000-000000000002",
      expiresAt: "2026-11-30 12:00:00+00"
    });
    const insert = calls.find((call) => call.sql.includes("INSERT INTO tenant_invitations"));
    expect(insert?.values).not.toContain("person@example.com");
    const outbox = calls.find((call) => call.sql.includes("INSERT INTO tenant_invitation_delivery_outbox"));
    expect(outbox).toBeDefined();
    expect(calls.some((call) => call.sql.includes("INSERT INTO tenant_invitation_audit_events"))).toBe(true);
  });

  it("rejects identities belonging to active or suspended tenant members", async () => {
    const target = await resolveInvitationTarget("email", "person@example.com", {
      async resolveAccountSubject() { return "existing-user"; }
    });
    const { tx } = fakeTransaction({ targetAlreadyMember: true });
    await expect(createTenantInvitation(
      tx,
      principal,
      target,
      "viewer",
      "10000000-0000-4000-8000-000000000002",
      keys
    )).rejects.toBeInstanceOf(InvitationConflictError);
  });

  it("rejects an untrusted, caller-constructed target object", async () => {
    const { tx } = fakeTransaction();
    await expect(createTenantInvitation(
      tx,
      principal,
      {
        identityType: "email",
        normalizedIdentity: "person@example.com",
        accountSubject: null
      },
      "viewer",
      "10000000-0000-4000-8000-000000000003",
      keys
    )).rejects.toThrow();
  });
});
