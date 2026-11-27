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
import { transitionTenantMembership } from "./membership-lifecycle.js";

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
      DATABASE_POOL_MAX: "4",
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

      const auditTable = await client.query<{
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(
        "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1",
        ["tenant_membership_audit_events"]
      );
      expect(auditTable.rows).toEqual([
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
      membershipId: expect.any(String),
      tenantId: "tenant-a",
      userId: "user-tenant-a",
      generation: 1,
      role: "owner",
      status: "active",
      version: "1"
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
        membershipId: expect.any(String),
        tenantId: "tenant-a",
        userId: "user-tenant-a",
        generation: 1,
        role: "owner",
        status: "active",
        version: "1"
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


  it("applies audited membership transitions and preserves removed generations", async () => {
    const owner = principalFor("tenant-a");
    const targetUserId = "user-lifecycle-target";
    const target = principalFor("tenant-a", targetUserId);

    await withTenantTransaction(tenantPool, owner, (transaction) =>
      transaction.query(
        "INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)",
        ["tenant-a", targetUserId, "viewer"]
      )
    );

    const suspendId = "10000000-0000-4000-8000-000000000001";
    await expect(withTenantTransaction(tenantPool, owner, (transaction) =>
      transitionTenantMembership(transaction, owner, targetUserId, "suspended", suspendId)
    )).resolves.toEqual({ outcome: "succeeded" });

    await expect(withTenantTransaction(tenantPool, target, (transaction) =>
      getTenantMembership(transaction, target)
    )).resolves.toBeNull();

    const reactivateId = "10000000-0000-4000-8000-000000000002";
    await expect(withTenantTransaction(tenantPool, owner, (transaction) =>
      transitionTenantMembership(transaction, owner, targetUserId, "active", reactivateId)
    )).resolves.toEqual({ outcome: "succeeded" });

    const removeId = "10000000-0000-4000-8000-000000000003";
    await expect(withTenantTransaction(tenantPool, owner, (transaction) =>
      transitionTenantMembership(transaction, owner, targetUserId, "removed", removeId)
    )).resolves.toEqual({ outcome: "succeeded" });

    await expect(withTenantTransaction(tenantPool, owner, (transaction) =>
      transitionTenantMembership(transaction, owner, targetUserId, "removed", removeId)
    )).resolves.toEqual({ outcome: "succeeded" });

    await withTenantTransaction(tenantPool, owner, (transaction) =>
      transaction.query(
        "INSERT INTO tenant_memberships (tenant_id, user_id, role, generation) VALUES ($1, $2, $3, $4)",
        ["tenant-a", targetUserId, "viewer", 2]
      )
    );

    const current = await withTenantTransaction(tenantPool, target, (transaction) =>
      getTenantMembership(transaction, target)
    );
    expect(current).toMatchObject({
      tenantId: "tenant-a",
      userId: targetUserId,
      generation: 2,
      status: "active",
      role: "viewer"
    });

    await expect(withTenantTransaction(tenantPool, owner, (transaction) =>
      transitionTenantMembership(
        transaction,
        owner,
        targetUserId,
        "suspended",
        "10000000-0000-4000-8000-000000000004"
      )
    )).resolves.toEqual({ outcome: "succeeded" });

    await expect(withTenantTransaction(tenantPool, target, (transaction) =>
      getTenantMembership(transaction, target)
    )).resolves.toBeNull();

    const audit = await withTenantTransaction(tenantPool, owner, (transaction) =>
      transaction.query<{ requested_status: string; outcome: string }>(
        "SELECT requested_status, outcome FROM tenant_membership_audit_events WHERE tenant_id = $1 AND target_user_id = $2 ORDER BY occurred_at",
        ["tenant-a", targetUserId]
      )
    );
    expect(audit).toHaveLength(4);
    expect(audit.map((row) => row.outcome)).toEqual([
      "succeeded", "succeeded", "succeeded", "succeeded"
    ]);
  });

  it("records denied owner-target lifecycle attempts without changing the owner", async () => {
    const owner = principalFor("tenant-a");
    const admin = principalFor("tenant-a", "user-lifecycle-admin");
    await withTenantTransaction(tenantPool, owner, (transaction) =>
      transaction.query(
        "INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)",
        ["tenant-a", "user-lifecycle-admin", "admin"]
      )
    );

    await expect(withTenantTransaction(tenantPool, admin, (transaction) =>
      transitionTenantMembership(
        transaction,
        admin,
        "user-tenant-a",
        "suspended",
        "20000000-0000-4000-8000-000000000001"
      )
    )).resolves.toEqual({ outcome: "denied" });

    const audit = await withTenantTransaction(tenantPool, owner, (transaction) =>
      transaction.query<{ outcome: string }>(
        "SELECT outcome FROM tenant_membership_audit_events WHERE tenant_id = $1 AND correlation_id = $2",
        ["tenant-a", "20000000-0000-4000-8000-000000000001"]
      )
    );
    expect(audit).toEqual([{ outcome: "denied" }]);

    const crossTenantAudit = await withTenantTransaction(
      tenantPool,
      principalFor("tenant-b"),
      (transaction) => transaction.query<{ outcome: string }>(
        "SELECT outcome FROM tenant_membership_audit_events WHERE tenant_id = $1 AND correlation_id = $2",
        ["tenant-a", "20000000-0000-4000-8000-000000000001"]
      )
    );
    expect(crossTenantAudit).toEqual([]);

    await expect(withTenantTransaction(tenantPool, owner, (transaction) =>
      transaction.query(
        "UPDATE tenant_membership_audit_events SET outcome = $1 WHERE tenant_id = $2 AND correlation_id = $3",
        ["succeeded", "tenant-a", "20000000-0000-4000-8000-000000000001"]
      )
    )).rejects.toBeInstanceOf(TenantPersistenceError);

    const ownerMembership = await withTenantTransaction(tenantPool, owner, (transaction) =>
      getTenantMembership(transaction, owner)
    );
    expect(ownerMembership?.status).toBe("active");
  });


  it("does not grant membership role changes or hard deletion to the app role", async () => {
    const owner = principalFor("tenant-a");
    await expect(withTenantTransaction(tenantPool, owner, (transaction) =>
      transaction.query(
        "UPDATE tenant_memberships SET role = $1 WHERE tenant_id = $2 AND user_id = $3",
        ["admin", "tenant-a", "user-tenant-a"]
      )
    )).rejects.toBeInstanceOf(TenantPersistenceError);

    await expect(withTenantTransaction(tenantPool, owner, (transaction) =>
      transaction.query(
        "DELETE FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2",
        ["tenant-a", "user-tenant-a"]
      )
    )).rejects.toBeInstanceOf(TenantPersistenceError);
  });


  it("serializes concurrent lifecycle changes for one tenant", async () => {
    const owner = principalFor("tenant-a");
    const targetUserId = "user-lifecycle-concurrent";
    const target = principalFor("tenant-a", targetUserId);

    await withTenantTransaction(tenantPool, owner, (transaction) =>
      transaction.query(
        "INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)",
        ["tenant-a", targetUserId, "viewer"]
      )
    );

    const outcomes = await Promise.all([
      withTenantTransaction(tenantPool, owner, (transaction) =>
        transitionTenantMembership(
          transaction,
          owner,
          targetUserId,
          "suspended",
          "40000000-0000-4000-8000-000000000001"
        )
      ),
      withTenantTransaction(tenantPool, owner, (transaction) =>
        transitionTenantMembership(
          transaction,
          owner,
          targetUserId,
          "removed",
          "40000000-0000-4000-8000-000000000002"
        )
      )
    ]);

    expect(outcomes.some((result) => result.outcome === "succeeded")).toBe(true);
    const history = await withTenantTransaction(tenantPool, owner, (transaction) =>
      transaction.query<{ status: string; version: string }>(
        "SELECT status, version FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2 ORDER BY generation DESC LIMIT 1",
        ["tenant-a", targetUserId]
      )
    );
    expect(history[0]?.status).toBe("removed");
    await expect(withTenantTransaction(tenantPool, target, (transaction) =>
      getTenantMembership(transaction, target)
    )).resolves.toBeNull();
  });

});

  it("requires an audit event for direct lifecycle updates and blocks removed reactivation", async () => {
    const owner = principalFor("tenant-a");
    const targetUserId = "user-lifecycle-trigger-guard";
    const target = principalFor("tenant-a", targetUserId);

    await withTenantTransaction(tenantPool, owner, (transaction) =>
      transaction.query(
        "INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)",
        ["tenant-a", targetUserId, "viewer"]
      )
    );

    await expect(withTenantTransaction(tenantPool, target, (transaction) =>
      transaction.query(
        "UPDATE tenant_memberships SET status = $1, status_changed_at = now(), status_changed_by = $2, status_change_correlation_id = $5, version = version + 1 WHERE tenant_id = $3 AND user_id = $4",
        ["suspended", targetUserId, "tenant-a", targetUserId, "30000000-0000-4000-8000-000000000003"]
      )
    )).rejects.toBeInstanceOf(TenantPersistenceError);

    await expect(withTenantTransaction(tenantPool, owner, (transaction) =>
      transaction.query(
        "UPDATE tenant_memberships SET status = $1, status_changed_at = now(), status_changed_by = $2, version = version + 1 WHERE tenant_id = $3 AND user_id = $4",
        ["suspended", owner.subject, "tenant-a", targetUserId]
      )
    )).rejects.toBeInstanceOf(TenantPersistenceError);

    await expect(withTenantTransaction(tenantPool, owner, (transaction) =>
      transaction.query(
        "UPDATE tenant_memberships SET status = $1, status_changed_at = now(), status_changed_by = $2, version = version + 1 WHERE tenant_id = $3 AND user_id = $4",
        ["suspended", "user-lifecycle-trigger-guard", "tenant-a", "user-tenant-a"]
      )
    )).rejects.toBeInstanceOf(TenantPersistenceError);

    await expect(withTenantTransaction(tenantPool, target, (transaction) =>
      getTenantMembership(transaction, target)
    )).resolves.toMatchObject({ status: "active" });

    await expect(withTenantTransaction(tenantPool, owner, (transaction) =>
      transitionTenantMembership(
        transaction,
        owner,
        targetUserId,
        "removed",
        "30000000-0000-4000-8000-000000000001"
      )
    )).resolves.toEqual({ outcome: "succeeded" });

    await expect(withTenantTransaction(tenantPool, owner, (transaction) =>
      transaction.query(
        "UPDATE tenant_memberships SET status = $1, status_changed_at = now(), status_changed_by = $2, version = version + 1 WHERE tenant_id = $3 AND user_id = $4",
        ["active", owner.subject, "tenant-a", targetUserId]
      )
    )).rejects.toBeInstanceOf(TenantPersistenceError);
  });

