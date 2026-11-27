import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createJwtPrincipalVerifier } from "../core/authenticated-principal.js";
import {
  getTenantMembership,
  requireTenantRole,
  TenantAuthorizationError,
  type TenantRole
} from "./tenant-membership.js";
import type { TenantSqlClient, TenantSqlPool } from "./tenant-transaction.js";

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

function poolWithRole(role: TenantRole | null): TenantSqlPool {
  const client: TenantSqlClient = {
    query: vi.fn(async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" ||
          sql.startsWith("SELECT set_config")) {
        return { rows: [], rowCount: null };
      }
      return { rows: role ? [{ role }] : [], rowCount: role ? 1 : 0 };
    }),
    release: vi.fn()
  };
  return { connect: vi.fn(async () => client) };
}

describe("tenant membership authorization", () => {
  it("resolves the role from the tenant membership row", async () => {
    await expect(
      getTenantMembership(poolWithRole("manager"), principal())
    ).resolves.toEqual({
      tenantId: "tenant-1",
      userId: "user-1",
      role: "manager"
    });
  });

  it("returns null when the user has no membership", async () => {
    await expect(
      getTenantMembership(poolWithRole(null), principal())
    ).resolves.toBeNull();
  });

  it("allows only explicitly permitted roles", async () => {
    await expect(
      requireTenantRole(poolWithRole("editor"), principal(), ["owner", "admin", "editor"])
    ).resolves.toMatchObject({ role: "editor" });
    await expect(
      requireTenantRole(poolWithRole("viewer"), principal(), ["owner", "admin", "editor"])
    ).rejects.toBeInstanceOf(TenantAuthorizationError);
  });

  it("does not treat an unrecognized database role as membership", async () => {
    await expect(
      getTenantMembership(poolWithRole("unexpected" as TenantRole), principal())
    ).resolves.toBeNull();
  });
});
