import { describe, expect, it, vi } from "vitest";
import { PostgresMemoryAuditPort, type AuditSqlConnection } from "../../src/core/postgres-memory-audit.js";
import type { MemoryAccessDecidedEvent } from "../../src/core/guarded-memory-port.js";

const event: MemoryAccessDecidedEvent = {
  tenantId: "tenant-a", actorId: "actor-a", moduleId: "notes",
  operation: "write", namespace: "tenant-a/notes", key: "k",
  decision: "allow", reason: "do not persist this policy prose"
};

function setup(shouldFail = false) {
  const statements: Array<{ sql: string; values?: readonly unknown[] }> = [];
  const connection: AuditSqlConnection = {
    query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
      statements.push({ sql, values });
      if (sql.startsWith("SELECT sequence")) return { rows: [{ sequence: 0, head_hash: "0".repeat(64) }] };
      if (shouldFail && sql.startsWith("INSERT")) throw new Error("database unavailable");
      return { rows: [], rowCount: 1 };
    }),
    release: vi.fn()
  };
  const pool = { connect: vi.fn(async () => connection) };
  return { connection, pool, statements };
}

describe("PostgresMemoryAuditPort", () => {
  it("writes a chained audit record transactionally without policy prose", async () => {
    const state = setup();
    const audit = new PostgresMemoryAuditPort(state.pool);
    await expect(audit.publishDecision(event)).resolves.toBe(true);
    expect(state.statements.map((s) => s.sql)).toEqual(expect.arrayContaining([
      "BEGIN", expect.stringContaining("INSERT INTO infinyx_audit.memory_access_events"),
      expect.stringContaining("UPDATE infinyx_audit.audit_chain_state"), "COMMIT"
    ]));
    const insert = state.statements.find((s) => s.sql.startsWith("INSERT"))!;
    expect(JSON.stringify(insert.values)).not.toContain("do not persist this policy prose");
    expect(insert.values).toContain("POLICY_ALLOW");
    expect(state.connection.release).toHaveBeenCalledOnce();
  });

  it("rolls back and propagates audit failures so guarded writes fail closed", async () => {
    const state = setup(true);
    const audit = new PostgresMemoryAuditPort(state.pool);
    await expect(audit.publishDecision(event)).rejects.toThrow("database unavailable");
    expect(state.statements.some((s) => s.sql === "ROLLBACK")).toBe(true);
    expect(state.connection.release).toHaveBeenCalledOnce();
  });
});
