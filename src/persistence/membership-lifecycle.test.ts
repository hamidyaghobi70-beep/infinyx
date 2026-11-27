import { describe, expect, it } from "vitest";
import type { AuthenticatedPrincipal } from "../core/authenticated-principal.js";
import {
  MembershipLifecycleIdempotencyConflictError,
  transitionTenantMembership
} from "./membership-lifecycle.js";
import type { TenantTransaction } from "./tenant-transaction.js";

const principal = {
  subject: "owner-user",
  tenantId: "tenant-1"
} as AuthenticatedPrincipal;
const correlationId = "00000000-0000-4000-8000-000000000001";

interface Member {
  membership_id: string;
  user_id: string;
  role: string;
  status: string;
  generation: number;
  version: string;
}

function makeTransaction(options: {
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
  const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  const actor: Member | null = options.actor === null ? null : {
    membership_id: "00000000-0000-4000-8000-000000000010",
    user_id: principal.subject,
    role: "owner",
    status: "active",
    generation: 1,
    version: "1",
    ...options.actor
  };
  const target: Member | null = options.target === null ? null : {
    membership_id: "00000000-0000-4000-8000-000000000020",
    user_id: "target-user",
    role: "viewer",
    status: "active",
    generation: 1,
    version: "1",
    ...options.target
  };
  const tx: TenantTransaction = {
    query: async <Row = Record<string, unknown>>(
      sql: string,
      values: readonly unknown[] = []
    ): Promise<readonly Row[]> => {
      calls.push({ sql, values });
      if (sql.startsWith("SELECT id FROM tenants")) return [{ id: "tenant-1" }] as unknown as readonly Row[];
      if (sql.includes("FROM tenant_membership_audit_events") && sql.startsWith("SELECT")) {
        return (options.priorAudit ? [options.priorAudit] : []) as unknown as readonly Row[];
      }
      if (sql.includes("FROM tenant_memberships") && sql.startsWith("SELECT")) {
        return [actor, target].filter((row): row is Member => row !== null) as unknown as readonly Row[];
      }
      if (sql.startsWith("UPDATE tenant_memberships")) return [{ membership_id: target?.membership_id }] as unknown as readonly Row[];
      if (sql.startsWith("INSERT INTO tenant_membership_audit_events")) {
        if (options.failAudit) throw new Error("audit insert failed");
        return [];
      }
      throw new Error("Unexpected query");
    }
  };
  return { tx, calls };
}

describe("membership lifecycle repository", () => {
  it("locks the tenant, changes status, and writes audit in the same transaction", async () => {
    const db = makeTransaction();
    await expect(transitionTenantMembership(
      db.tx, principal, "target-user", "suspended", correlationId
    )).resolves.toEqual({ outcome: "succeeded" });

    expect(db.calls[0]?.sql).toContain("FOR UPDATE");
    const updateIndex = db.calls.findIndex((call) => call.sql.startsWith("UPDATE tenant_memberships"));
    const auditIndex = db.calls.findIndex((call) => call.sql.startsWith("INSERT INTO tenant_membership_audit_events"));
    expect(updateIndex).toBeGreaterThan(0);
    expect(auditIndex).toBeGreaterThan(updateIndex);
    expect(db.calls[auditIndex]?.values).toContain("succeeded");
  });

  it("audits and denies self-suspension", async () => {
    const db = makeTransaction();
    await expect(transitionTenantMembership(
      db.tx, principal, principal.subject, "suspended", correlationId
    )).resolves.toEqual({ outcome: "denied" });
    expect(db.calls.some((call) => call.sql.startsWith("UPDATE tenant_memberships"))).toBe(false);
    expect(db.calls.some((call) => call.sql.startsWith("INSERT INTO tenant_membership_audit_events"))).toBe(true);
  });

  it("protects owner targets from the ordinary lifecycle endpoint", async () => {
    const db = makeTransaction({ target: { role: "owner" } });
    await expect(transitionTenantMembership(
      db.tx, principal, "target-user", "removed", correlationId
    )).resolves.toEqual({ outcome: "denied" });
    expect(db.calls.some((call) => call.sql.startsWith("UPDATE tenant_memberships"))).toBe(false);
  });

  it("denies inactive or non-administrative actors", async () => {
    const db = makeTransaction({ actor: { status: "suspended" } });
    await expect(transitionTenantMembership(
      db.tx, principal, "target-user", "suspended", correlationId
    )).resolves.toEqual({ outcome: "denied" });
    expect(db.calls.some((call) => call.sql.startsWith("UPDATE tenant_memberships"))).toBe(false);
  });

  it("treats a removed membership as terminal", async () => {
    const db = makeTransaction({ target: { status: "removed" } });
    await expect(transitionTenantMembership(
      db.tx, principal, "target-user", "active", correlationId
    )).resolves.toEqual({ outcome: "denied" });
    expect(db.calls.some((call) => call.sql.startsWith("UPDATE tenant_memberships"))).toBe(false);
  });

  it("returns a stable no-op for a repeated state", async () => {
    const db = makeTransaction({ target: { status: "suspended" } });
    await expect(transitionTenantMembership(
      db.tx, principal, "target-user", "suspended", correlationId
    )).resolves.toEqual({ outcome: "noop" });
    expect(db.calls.some((call) => call.sql.startsWith("UPDATE tenant_memberships"))).toBe(false);
  });

  it("treats a removed-to-removed request as a stable no-op", async () => {
    const db = makeTransaction({ target: { status: "removed" } });
    await expect(transitionTenantMembership(
      db.tx, principal, "target-user", "removed", correlationId
    )).resolves.toEqual({ outcome: "noop" });
    expect(db.calls.some((call) => call.sql.startsWith("UPDATE tenant_memberships"))).toBe(false);
  });

  it("returns an earlier result for an identical idempotent retry", async () => {
    const db = makeTransaction({
      priorAudit: {
        actor_user_id: principal.subject,
        target_user_id: "target-user",
        requested_status: "suspended",
        outcome: "succeeded"
      }
    });
    await expect(transitionTenantMembership(
      db.tx, principal, "target-user", "suspended", correlationId
    )).resolves.toEqual({ outcome: "succeeded" });
    expect(db.calls.some((call) => call.sql.startsWith("UPDATE tenant_memberships"))).toBe(false);
  });

  it("rejects reuse of an idempotency key for a different operation", async () => {
    const db = makeTransaction({
      priorAudit: {
        actor_user_id: principal.subject,
        target_user_id: "someone-else",
        requested_status: "suspended",
        outcome: "succeeded"
      }
    });
    await expect(transitionTenantMembership(
      db.tx, principal, "target-user", "suspended", correlationId
    )).rejects.toBeInstanceOf(MembershipLifecycleIdempotencyConflictError);
  });

  it("propagates audit failure so the surrounding transaction must roll back", async () => {
    const db = makeTransaction({ failAudit: true });
    await expect(transitionTenantMembership(
      db.tx, principal, "target-user", "suspended", correlationId
    )).rejects.toThrow("audit insert failed");
  });
});
