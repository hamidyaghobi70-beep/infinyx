import { describe, expect, it } from "vitest";
import {
  PostgresMemoryAuditAdapter,
  type PgClient,
  type PgPool,
  type PgQueryResult
} from "../../src/security/postgres-memory-audit-adapter.js";

describe("PostgresMemoryAuditAdapter input validation", () => {
  const adapter = new PostgresMemoryAuditAdapter({
    pool: { connect: async () => { throw new Error("must not connect"); } }
  });

  it("rejects malformed operation IDs before opening a connection", async () => {
    await expect(adapter.getOperation("not-a-uuid")).rejects.toThrow("valid UUID");
  });

  it("rejects invalid page limits before opening a connection", async () => {
    await expect(adapter.listUnresolved(null, 501)).rejects.toThrow("1 to 500");
  });

  it("rejects malformed cursors before opening a connection", async () => {
    await expect(adapter.listUnresolved("invalid")).rejects.toThrow("valid UUID");
  });
});

class ScriptedClient implements PgClient {
  readonly statements: string[] = [];
  released = false;
  async query<Row>(sql: string): Promise<PgQueryResult<Row>> {
    this.statements.push(sql.trim().split(/\\s+/).slice(0, 2).join(" "));
    return { rows: [] };
  }
  release(): void { this.released = true; }
}

describe("PostgreSQL adapter transaction boundaries", () => {
  it("releases a client after a successful lookup", async () => {
    const client = new ScriptedClient();
    const pool: PgPool = { connect: async () => client };
    const adapter = new PostgresMemoryAuditAdapter({ pool });
    const result = await adapter.getOperation("00000000-0000-4000-8000-000000000001");
    expect(result.status).toBe("not_found");
    expect(client.released).toBe(true);
  });
});
