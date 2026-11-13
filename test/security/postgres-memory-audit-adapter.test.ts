import { describe, expect, it } from "vitest";
import {
  PostgresMemoryAuditAdapter,
  type PgClient,
  type PgPool,
  type PgQueryResult
} from "../../src/security/postgres-memory-audit-adapter.js";
import type { MemoryAccessDecidedEvent } from "../../src/core/guarded-memory-port.js";

const operationId = "00000000-0000-4000-8000-000000000001";
const eventId = "00000000-0000-4000-8000-000000000002";

const validDecision: MemoryAccessDecidedEvent = {
  tenantId: "tenant-a",
  actorId: "actor-a",
  moduleId: "module-a",
  operation: "write",
  namespace: "profile",
  key: "display-name",
  decision: "allow",
  reason: "policy-allowed"
};

function noConnectPool(): PgPool {
  return {
    connect: async () => { throw new Error("must not connect"); }
  };
}

describe("PostgresMemoryAuditAdapter input validation", () => {
  const adapter = new PostgresMemoryAuditAdapter({ pool: noConnectPool() });

  it("rejects malformed operation IDs before opening a connection", async () => {
    await expect(adapter.getOperation("not-a-uuid")).rejects.toThrow("valid UUID");
  });

  it("rejects invalid page limits before opening a connection", async () => {
    await expect(adapter.listUnresolved(null, 501)).rejects.toThrow("1 to 500");
  });

  it("rejects malformed cursors before opening a connection", async () => {
    await expect(adapter.listUnresolved("invalid")).rejects.toThrow("valid UUID");
  });

  it("rejects control characters in decision fields before opening a connection", async () => {
    const invalid = { ...validDecision, reason: "policy\nallowed" };
    await expect(adapter.recordDecision(operationId, invalid)).rejects.toThrow("Invalid audit field: reason");
  });

  it("rejects an empty decision field before opening a connection", async () => {
    const invalid = { ...validDecision, namespace: "" };
    await expect(adapter.recordDecision(operationId, invalid)).rejects.toThrow("Invalid audit field: namespace");
  });

  it("rejects malformed outcome event IDs before opening a connection", async () => {
    await expect(adapter.appendOutcome(operationId, "bad-id", "EFFECT_SUCCEEDED")).rejects.toThrow("valid UUID");
  });

  it("rejects unsupported outcomes before opening a connection", async () => {
    await expect(
      adapter.appendOutcome(operationId, eventId, "UNSUPPORTED" as "EFFECT_SUCCEEDED")
    ).rejects.toThrow("Unsupported audit outcome");
  });

  it("rejects unbounded or unsafe details codes before opening a connection", async () => {
    await expect(adapter.appendOutcome(operationId, eventId, "EFFECT_SUCCEEDED", "unsafe code"))
      .rejects.toThrow("bounded non-sensitive code");
  });
});

class ScriptedClient implements PgClient {
  readonly statements: string[] = [];
  released = false;

  constructor(private readonly failOn?: string, private readonly failure = new Error("scripted query failure")) {}

  async query<Row>(sql: string): Promise<PgQueryResult<Row>> {
    this.statements.push(sql.trim().split(/\s+/).slice(0, 2).join(" "));
    if (this.failOn && sql.includes(this.failOn)) throw this.failure;
    return { rows: [] };
  }

  release(): void {
    this.released = true;
  }
}

describe("PostgreSQL adapter resource and transaction boundaries", () => {
  it("releases a client after a successful lookup", async () => {
    const client = new ScriptedClient();
    const pool: PgPool = { connect: async () => client };
    const adapter = new PostgresMemoryAuditAdapter({ pool });
    const result = await adapter.getOperation(operationId);

    expect(result.status).toBe("not_found");
    expect(client.released).toBe(true);
  });

  it("rolls back after a failed decision insert and always releases the client", async () => {
    const failure = new Error("insert failed");
    const client = new ScriptedClient("INSERT INTO memory_audit_operations", failure);
    const pool: PgPool = { connect: async () => client };
    const adapter = new PostgresMemoryAuditAdapter({ pool });

    await expect(adapter.recordDecision(operationId, validDecision)).rejects.toBe(failure);
    expect(client.statements).toContain("BEGIN");
    expect(client.statements).toContain("ROLLBACK");
    expect(client.released).toBe(true);
  });

  it("returns unavailable rather than not-found when the database connection fails", async () => {
    const adapter = new PostgresMemoryAuditAdapter({
      pool: { connect: async () => { throw new Error("database unavailable"); } }
    });

    await expect(adapter.getOperation(operationId)).resolves.toEqual({
      status: "unavailable",
      operationId
    });
  });
});
