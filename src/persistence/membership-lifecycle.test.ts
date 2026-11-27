import { describe, expect, it } from "vitest";
import { createTestPrincipal } from "../core/testing/test-principal.js";
import {
  MembershipLifecycleIdempotencyConflictError,
  transitionTenantMembership
} from "./membership-lifecycle.js";
import {
  TenantAuthorizationError,
  TenantPersistenceError,
  withTenantTransaction,
  type SqlQueryResult,
  type TenantSqlClient,
  type TenantSqlPool
} from "./tenant-transaction.js";

const issuer = "https://infinyx.lifecycle.test";
const audience = "infinyx-test";
const userId = "10000000-0000-4000-8000-000000000001";
const targetUserId = "10000000-0000-4000-8000-000000000002";
const correlationId = "00000000-0000-4000-8000-000000000001";
const principal = await createTestPrincipal({
  issuer, audience, subject: "owner-provider-sub", userId
});

interface Member {
  membership_id: string;
  user_id: string;
  role: string;
  status: string;
  generation: number;
  version: string;
}

function makePool(options: {
  actor?: Partial<Member> | null;
  target?: Partial<Member> | null;
  priorAudit?: {
    actor_user_id: string;
    target_user_id: string;
    requested_status: string;
    outcome: "succeeded" | "denied" | "noop";
  } | null;
  failAudit?: boolean;
} = {}) {
  const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
  const actor: Member | null = options.actor === null ? null : {
    membership_id: "00000000-0000-4000-8000-000000000010",
    user_id: userId, role: "owner", status: "active", generation: 1, version: "1",
    ...options.actor
  };
  const target: Member | null = options.target === null ? null : {
    membership_id: "00000000-0000-4000-8000-000000000020",
    user_id: targetUserId, role: "viewer", status: "active", generation: 1, version: "1",
    ...options.target
  };

  const client: TenantSqlClient = {
    async query<Row = Record<string, unknown>>(
      sql: string,
      values?: readonly unknown[]
    ): Promise<SqlQueryResult<Row>> {
      calls.push({ sql, values });
      if (sql.includes("internal_user_id = $2::uuid") && sql.startsWith("SELECT membership_id")) {
        return {
          rows: actor && actor.status === "active"
            ? [{ membership_id: actor.membership_id, role: actor.role, generation: actor.generation, version: actor.version } as Row]
            : [],
          rowCount: actor && actor.status === "active" ? 1 : 0
        };
      }
      if (sql.startsWith("SELECT id FROM tenants")) return { rows: [{ id: "tenant-1" } as Row], rowCount: 1 };
      if (sql.includes("FROM tenant_membership_audit_events") && sql.startsWith("SELECT")) {
        return { rows: (options.priorAudit ? [options.priorAudit as Row] : []), rowCount: options.priorAudit ? 1 : 0 };
      }
      if (sql.includes("FROM tenant_memberships") && sql.startsWith("SELECT")) {
        const rows = [actor, target].filter((row): row is Member => row !== null);
        return { rows: rows as unknown as Row[], rowCount: rows.length };
      }
      if (sql.startsWith("UPDATE tenant_memberships")) {
        return { rows: [{ membership_id: target?.membership_id } as Row], rowCount: 1 };
      }
      if (sql.startsWith("INSERT INTO tenant_membership_audit_events")) {
        if (options.failAudit) throw new Error("audit insert failed");
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {}
  };
  const pool: TenantSqlPool = { async connect() { return client; } };
  return { pool, calls };
}

function transition(
  db: ReturnType<typeof makePool>,
  target: string,
  status: "active" | "suspended" | "removed" = "suspended"
) {
  return withTenantTransaction(db.pool, principal, "tenant-1", (transaction) =>
    transitionTenantMembership(transaction, principal, target, status, correlationId)
  );
}

describe("membership lifecycle repository", () => {
  it("locks the tenant, changes status, and writes audit in the same transaction", async () => {
    const db = makePool();
    await expect(transition(db, targetUserId)).resolves.toEqual({ outcome: "succeeded" });
    expect(db.calls.some((call) => call.sql.includes("SELECT id FROM tenants") && call.sql.includes("FOR UPDATE"))).toBe(true);
    const updateIndex = db.calls.findIndex((call) => call.sql.startsWith("UPDATE tenant_memberships"));
    const auditIndex = db.calls.findIndex((call) => call.sql.startsWith("INSERT INTO tenant_membership_audit_events"));
    expect(updateIndex).toBeGreaterThan(0);
    expect(auditIndex).toBeGreaterThan(updateIndex);
    expect(db.calls[auditIndex]?.values).toContain("succeeded");
  });

  it("audits and denies self-suspension", async () => {
    const db = makePool();
    await expect(transition(db, userId)).resolves.toEqual({ outcome: "denied" });
    expect(db.calls.some((call) => call.sql.startsWith("UPDATE tenant_memberships"))).toBe(false);
    expect(db.calls.some((call) => call.sql.startsWith("INSERT INTO tenant_membership_audit_events"))).toBe(true);
  });

  it("protects owner targets from the ordinary lifecycle endpoint", async () => {
    const db = makePool({ target: { role: "owner" } });
    await expect(transition(db, targetUserId, "removed")).resolves.toEqual({ outcome: "denied" });
    expect(db.calls.some((call) => call.sql.startsWith("UPDATE tenant_memberships"))).toBe(false);
  });

  it("blocks suspended actors at the transaction boundary", async () => {
    const db = makePool({ actor: { status: "suspended" } });
    await expect(transition(db, targetUserId)).rejects.toBeInstanceOf(TenantAuthorizationError);
    expect(db.calls.some((call) => call.sql.startsWith("INSERT INTO tenant_membership_audit_events"))).toBe(false);
  });

  it("denies active members without owner/admin roles", async () => {
    const db = makePool({ actor: { role: "manager" } });
    await expect(transition(db, targetUserId)).resolves.toEqual({ outcome: "denied" });
    expect(db.calls.some((call) => call.sql.startsWith("UPDATE tenant_memberships"))).toBe(false);
  });

  it("treats a removed membership as terminal and repeated state as no-op", async () => {
    const removed = makePool({ target: { status: "removed" } });
    await expect(transition(removed, targetUserId, "removed")).resolves.toEqual({ outcome: "noop" });
    const repeated = makePool({ target: { status: "suspended" } });
    await expect(transition(repeated, targetUserId)).resolves.toEqual({ outcome: "noop" });
  });

  it("returns an earlier result for an identical idempotent retry", async () => {
    const db = makePool({
      priorAudit: {
        actor_user_id: userId,
        target_user_id: targetUserId,
        requested_status: "suspended",
        outcome: "succeeded"
      }
    });
    await expect(transition(db, targetUserId)).resolves.toEqual({ outcome: "succeeded" });
    expect(db.calls.some((call) => call.sql.startsWith("UPDATE tenant_memberships"))).toBe(false);
  });

  it("rejects reuse of an idempotency key for a different operation", async () => {
    const db = makePool({
      priorAudit: {
        actor_user_id: userId,
        target_user_id: "10000000-0000-4000-8000-000000000003",
        requested_status: "suspended",
        outcome: "succeeded"
      }
    });
    await expect(transition(db, targetUserId)).rejects.toBeInstanceOf(MembershipLifecycleIdempotencyConflictError);
  });

  it("sanitizes audit persistence failure so the transaction rolls back", async () => {
    const db = makePool({ failAudit: true });
    await expect(transition(db, targetUserId)).rejects.toBeInstanceOf(TenantPersistenceError);
  });
});
