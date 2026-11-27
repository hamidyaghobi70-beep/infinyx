import { generateKeyPairSync, sign } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createJwtPrincipalVerifier
} from "../core/authenticated-principal.js";
import {
  createPostgresPool,
  createTenantSqlPool
} from "./postgres-pool.js";
import {
  TenantPersistenceError,
  withTenantTransaction
} from "./tenant-transaction.js";
import {
  getTenantMembership,
  requireTenantRole,
  TenantAuthorizationError
} from "./tenant-membership.js";
import { getCurrentTenant } from "./tenant-repository.js";

const databaseUrl = process.env.INFINYX_TEST_DATABASE_URL;
const integrationDescribe = databaseUrl ? describe : describe.skip;

interface TenantRow {
  id: string;
  name: string;
}

interface RoleRow {
  rolsuper: boolean;
  rolbypassrls: boolean;
}

const issuer = "https://infinyx.integration.test";
const audience = "infinyx-integration";

integrationDescribe("PostgreSQL tenant RLS integration", () => {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicKeyPem = keys.publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const verifyToken = createJwtPrincipalVerifier({
    issuer,
    audience,
    publicKeyPem
  });

  let pool: ReturnType<typeof createPostgresPool>;
  let tenantPool: ReturnType<typeof createTenantSqlPool>;

  function principalFor(tenantId: string, subject = `user-${tenantId}`) {
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = [
      encode({ alg: "RS256", typ: "JWT" }),
      encode({
        iss: issuer,
        aud: audience,
        sub: subject,
        tenant_id: tenantId,
        exp: Math.floor(Date.now() / 1000) + 60
      })
    ].join(".");
    const signature = sign(
      "RSA-SHA256",
      Buffer.from(unsigned, "ascii"),
      keys.privateKey
    ).toString("base64url");
    return verifyToken(`${unsigned}.${signature}`);
  }

  beforeAll(async () => {
    pool = createPostgresPool({
      DATABASE_URL: databaseUrl!,
      DATABASE_SSL: "disable",
      DATABASE_POOL_MAX: "1",
      DATABASE_CONNECTION_TIMEOUT_MS: "5000",
      DATABASE_IDLE_TIMEOUT_MS: "1000",
      DATABASE_STATEMENT_TIMEOUT_MS: "5000"
    });
    tenantPool = createTenantSqlPool(pool);
    const client = await pool.connect();
    try {
      const result = await client.query<{ current_user: string }>(
        "SELECT current_user"
      );
      expect(result.rows[0]?.current_user).toBe("infinyx_app");
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it("allows a tenant to read only its own tenant and membership rows", async () => {
    const rows = await withTenantTransaction(
      tenantPool,
      principalFor("tenant-a"),
      async (transaction) => {
        const tenants = await transaction.query<TenantRow>(
          "SELECT id, name FROM tenants ORDER BY id"
        );
        const memberships = await transaction.query<{ tenant_id: string }>(
          "SELECT tenant_id FROM tenant_memberships ORDER BY tenant_id"
        );
        return { tenants, memberships };
      }
    );

    expect(rows.tenants).toEqual([{ id: "tenant-a", name: "Tenant A" }]);
    expect(rows.memberships).toEqual([{ tenant_id: "tenant-a" }]);
  });

  it("prevents cross-tenant reads, updates, deletes, and inserts", async () => {
    const results = await withTenantTransaction(
      tenantPool,
      principalFor("tenant-a"),
      async (transaction) => {
        const read = await transaction.query<TenantRow>(
          "SELECT id, name FROM tenants WHERE id = $1",
          ["tenant-b"]
        );
        const update = await transaction.query<{ id: string }>(
          "UPDATE tenants SET name = $1 WHERE id = $2 RETURNING id",
          ["Compromised", "tenant-b"]
        );
        const remove = await transaction.query<{ id: string }>(
          "DELETE FROM tenants WHERE id = $1 RETURNING id",
          ["tenant-b"]
        );
        return { read, update, remove };
      }
    );

    expect(results.read).toEqual([]);
    expect(results.update).toEqual([]);
    expect(results.remove).toEqual([]);

    await expect(
      withTenantTransaction(
        tenantPool,
        principalFor("tenant-a"),
        (transaction) =>
          transaction.query(
            "INSERT INTO tenants (id, name) VALUES ($1, $2) RETURNING id",
            ["tenant-b", "Forged tenant"]
          )
      )
    ).rejects.toBeInstanceOf(TenantPersistenceError);
  });

  it("fails closed when no transaction-local tenant context exists", async () => {
    const client = await pool.connect();
    try {
      const result = await client.query<TenantRow>(
        "SELECT id, name FROM tenants ORDER BY id"
      );
      expect(result.rows).toEqual([]);
    } finally {
      client.release();
    }
  });

  it("does not leak tenant context when a pooled connection is reused", async () => {
    const tenantA = await withTenantTransaction(
      tenantPool,
      principalFor("tenant-a"),
      (transaction) => transaction.query<TenantRow>(
        "SELECT id, name FROM tenants"
      )
    );
    const tenantB = await withTenantTransaction(
      tenantPool,
      principalFor("tenant-b"),
      (transaction) => transaction.query<TenantRow>(
        "SELECT id, name FROM tenants"
      )
    );

    expect(tenantA.map((row) => row.id)).toEqual(["tenant-a"]);
    expect(tenantB.map((row) => row.id)).toEqual(["tenant-b"]);
  });

  it("uses a non-superuser application role without RLS bypass", async () => {
    const client = await pool.connect();
    try {
      const role = await client.query<RoleRow>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user"
      );
      expect(role.rows).toEqual([
        { rolsuper: false, rolbypassrls: false }
      ]);

      const table = await client.query<{
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(
        "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1",
        ["tenants"]
      );
      expect(table.rows).toEqual([
        { relrowsecurity: true, relforcerowsecurity: true }
      ]);
    } finally {
      client.release();
    }
  });
  it("resolves a tenant role only from the caller's membership row", async () => {
    const owner = principalFor("tenant-a");
    const membership = await withTenantTransaction(
      tenantPool,
      owner,
      (transaction) => getTenantMembership(transaction, owner)
    );
    expect(membership).toEqual({
      tenantId: "tenant-a",
      userId: "user-tenant-a",
      role: "owner"
    });
  });

  it("reads the current tenant through the membership-protected repository", async () => {
    const owner = principalFor("tenant-a");
    const result = await withTenantTransaction(
      tenantPool,
      owner,
      (transaction) => getCurrentTenant(transaction, owner)
    );

    expect(result).toEqual({
      tenant: {
        id: "tenant-a",
        name: "Tenant A",
        createdAt: expect.any(String)
      },
      membership: {
        tenantId: "tenant-a",
        userId: "user-tenant-a",
        role: "owner"
      }
    });
  });

  it("does not read tenant details when the principal has no membership", async () => {
    const nonMember = principalFor("tenant-a", "user-not-a-member");
    await expect(
      withTenantTransaction(
        tenantPool,
        nonMember,
        (transaction) => getCurrentTenant(transaction, nonMember)
      )
    ).rejects.toBeInstanceOf(TenantAuthorizationError);
  });

  it("denies users without a membership and enforces explicit role allowlists", async () => {
    await expect(
      withTenantTransaction(
        tenantPool,
        principalFor("tenant-a", "user-not-a-member"),
        (transaction) => getTenantMembership(
          transaction,
          principalFor("tenant-a", "user-not-a-member")
        )
      )
    ).resolves.toBeNull();

    await expect(
      withTenantTransaction(
        tenantPool,
        principalFor("tenant-a"),
        (transaction) => requireTenantRole(
          transaction,
          principalFor("tenant-a"),
          ["viewer", "editor"]
        )
      )
    ).rejects.toBeInstanceOf(TenantAuthorizationError);
  });

});
