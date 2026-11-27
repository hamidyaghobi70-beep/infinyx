import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createJwtPrincipalVerifier } from "../core/authenticated-principal.js";
import {
  getTenantMembership,
  requireTenantRole,
  TenantAuthorizationError,
  type TenantRole
} from "./tenant-membership.js";
import type { TenantTransaction } from "./tenant-transaction.js";

const issuer = "https://infinyx.membership.test";
const audience = "infinyx-membership-test";
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const verifier = createJwtPrincipalVerifier({
  issuer,
  audience,
  publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString()
});

function principal() {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = [
    encode({ alg: "RS256", typ: "JWT" }),
    encode({
      iss: issuer,
      aud: audience,
      sub: "user-1",
      tenant_id: "tenant-1",
      exp: Math.floor(Date.now() / 1000) + 60
    })
  ].join(".");
  const signature = sign("RSA-SHA256", Buffer.from(unsigned, "ascii"), keys.privateKey)
    .toString("base64url");
  return verifier(`${unsigned}.${signature}`);
}

function transactionWithRole(role: TenantRole | null, status = "active"): TenantTransaction {
  return {
    query: async <Row = Record<string, unknown>>(
      sql: string,
      _values?: readonly unknown[]
    ): Promise<readonly Row[]> => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" ||
          sql.startsWith("SELECT set_config")) {
        return [];
      }
      return role ? ([{
        membership_id: "00000000-0000-4000-8000-000000000001",
        generation: 1,
        role,
        status,
        version: "1"
      }] as unknown as readonly Row[]) : [];
    }
  };
}

describe("tenant membership authorization", () => {
  it("resolves the role from the tenant membership row", async () => {
    await expect(
      getTenantMembership(transactionWithRole("manager"), principal())
    ).resolves.toEqual({
      membershipId: "00000000-0000-4000-8000-000000000001",
      tenantId: "tenant-1",
      userId: "user-1",
      generation: 1,
      role: "manager",
      status: "active",
      version: "1"
    });
  });

  it("returns null when the user has no membership", async () => {
    await expect(
      getTenantMembership(transactionWithRole(null), principal())
    ).resolves.toBeNull();
  });

  it("allows only explicitly permitted roles", async () => {
    await expect(
      requireTenantRole(transactionWithRole("editor"), principal(), ["owner", "admin", "editor"])
    ).resolves.toMatchObject({ role: "editor" });
    await expect(
      requireTenantRole(transactionWithRole("viewer"), principal(), ["owner", "admin", "editor"])
    ).rejects.toBeInstanceOf(TenantAuthorizationError);
  });

  it("does not authorize suspended or removed memberships", async () => {
    await expect(
      getTenantMembership(transactionWithRole("manager", "suspended"), principal())
    ).resolves.toBeNull();
    await expect(
      getTenantMembership(transactionWithRole("manager", "removed"), principal())
    ).resolves.toBeNull();
  });

  it("does not treat an unrecognized database role as membership", async () => {
    await expect(
      getTenantMembership(transactionWithRole("unexpected" as TenantRole), principal())
    ).resolves.toBeNull();
  });
});
