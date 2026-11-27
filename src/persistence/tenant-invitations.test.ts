import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createAuthenticatedPrincipalResolver,
  createJwtPrincipalVerifier
} from "../core/authenticated-principal.js";
import {
  createTenantInvitation,
  InvitationConflictError,
  InvitationIntegrationUnavailableError,
  InvitationRequestError,
  resolveInvitationTarget
} from "./tenant-invitations.js";
import {
  withTenantTransaction,
  type SqlQueryResult,
  type TenantSqlClient,
  type TenantSqlPool
} from "./tenant-transaction.js";
import type { InvitationKeyMaterial } from "./tenant-invitation-crypto.js";

const issuer = "https://infinyx.invitation.test";
const audience = "infinyx-test";
const userId = "10000000-0000-4000-8000-000000000001";
const existingUserId = "10000000-0000-4000-8000-000000000002";
const keysPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const verifier = createJwtPrincipalVerifier({
  issuer, audience,
  publicKeyPem: keysPair.publicKey.export({ type: "spki", format: "pem" }).toString()
});
const principal = createAuthenticatedPrincipalResolver(() => userId)(
  (() => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = [
      encode({ alg: "RS256", typ: "JWT" }),
      encode({ iss: issuer, aud: audience, sub: "owner-provider-sub", exp: Math.floor(Date.now() / 1000) + 600 })
    ].join(".");
    return verifier(`${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned, "ascii"), keysPair.privateKey).toString("base64url")}`);
  })()
);

const keys: InvitationKeyMaterial = {
  tokenKey: Buffer.alloc(32, 3), tokenKeyVersion: 1,
  identityKey: Buffer.alloc(32, 5), identityKeyVersion: 1,
  deliveryKey: Buffer.alloc(32, 7), deliveryKeyVersion: 1
};

function fakePool(options: { targetAlreadyMember?: boolean } = {}) {
  const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
  const client: TenantSqlClient = {
    async query<Row = Record<string, unknown>>(
      sql: string,
      values?: readonly unknown[]
    ): Promise<SqlQueryResult<Row>> {
      calls.push({ sql, values });
      if (sql.includes("FROM tenant_memberships") && sql.includes("internal_user_id = $2::uuid") &&
          sql.includes("AND status = 'active'") && sql.includes("SELECT membership_id::text AS membership_id, role")) {
        return { rows: [{
          membership_id: "00000000-0000-4000-8000-000000000010",
          role: "owner", generation: 1, version: "1"
        } as Row], rowCount: 1 };
      }
      if (sql.startsWith("SELECT id FROM tenants")) return { rows: [{ id: "tenant-a" } as Row], rowCount: 1 };
      if (sql.includes("FROM tenant_memberships") &&
          sql.includes("SELECT membership_id::text AS membership_id, generation, role, status")) {
        return { rows: [{
          membership_id: "00000000-0000-4000-8000-000000000010",
          generation: 1, role: "owner", status: "active", version: "1"
        } as Row], rowCount: 1 };
      }
      if (sql.includes("FROM tenant_memberships") && sql.includes("internal_user_id = $2::uuid")) {
        return { rows: options.targetAlreadyMember ? [{ membership_id: "existing" } as Row] : [], rowCount: options.targetAlreadyMember ? 1 : 0 };
      }
      if (sql.startsWith("INSERT INTO tenant_invitations")) {
        return { rows: [{
          invitation_id: "00000000-0000-4000-8000-000000000002",
          expires_at: "2026-11-30 12:00:00+00"
        } as Row], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {}
  };
  const pool: TenantSqlPool = { async connect() { return client; } };
  return { pool, calls };
}

describe("tenant invitation creation", () => {
  it("fails closed when no trusted identity directory is configured", async () => {
    await expect(resolveInvitationTarget("email", "person@example.com", null))
      .rejects.toBeInstanceOf(InvitationIntegrationUnavailableError);
  });

  it("resolves normalized invitee identity to an internal user ID", async () => {
    const target = await resolveInvitationTarget("email", " Person@Example.com ", {
      async resolveInternalUserId(type, identity) {
        expect(type).toBe("email");
        expect(identity).toBe("person@example.com");
        return existingUserId;
      }
    });
    expect(target).toMatchObject({
      identityType: "email",
      normalizedIdentity: "person@example.com",
      internalUserId: existingUserId
    });
  });

  it("stores only hashes and encrypted delivery data and returns no raw token", async () => {
    const target = await resolveInvitationTarget("email", "person@example.com", {
      async resolveInternalUserId() { return null; }
    });
    const db = fakePool();
    const result = await withTenantTransaction(db.pool, principal, "tenant-a", (tx) =>
      createTenantInvitation(tx, principal, target, "viewer",
        "10000000-0000-4000-8000-000000000001", keys)
    );
    expect(result).toEqual({
      invitationId: "00000000-0000-4000-8000-000000000002",
      expiresAt: "2026-11-30 12:00:00+00"
    });
    const insert = db.calls.find((call) => call.sql.includes("INSERT INTO tenant_invitations"));
    expect(insert?.values).not.toContain("person@example.com");
    expect(db.calls.some((call) => call.sql.includes("INSERT INTO tenant_invitation_delivery_outbox"))).toBe(true);
    expect(db.calls.some((call) => call.sql.includes("INSERT INTO tenant_invitation_audit_events"))).toBe(true);
  });

  it("rejects identities already mapped to an active or suspended tenant member", async () => {
    const target = await resolveInvitationTarget("email", "person@example.com", {
      async resolveInternalUserId() { return existingUserId; }
    });
    const db = fakePool({ targetAlreadyMember: true });
    await expect(withTenantTransaction(db.pool, principal, "tenant-a", (tx) =>
      createTenantInvitation(tx, principal, target, "viewer",
        "10000000-0000-4000-8000-000000000002", keys)
    )).rejects.toBeInstanceOf(InvitationConflictError);
  });

  it("rejects a caller-constructed target object", async () => {
    const db = fakePool();
    await expect(withTenantTransaction(db.pool, principal, "tenant-a", (tx) =>
      createTenantInvitation(tx, principal, {
        identityType: "email",
        normalizedIdentity: "person@example.com",
        internalUserId: null
      }, "viewer", "10000000-0000-4000-8000-000000000003", keys)
    )).rejects.toBeInstanceOf(InvitationRequestError);
  });
});
