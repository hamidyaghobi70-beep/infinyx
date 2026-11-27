import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresPool } from "./postgres-pool.js";
import {
  createInternalUser,
  linkExternalIdentity,
  type IdentityTransaction
} from "./internal-identities.js";

const databaseUrl = process.env.INFINYX_TEST_DATABASE_URL;
const integrationDescribe = databaseUrl ? describe : describe.skip;
const issuer = "https://infinyx.identity-lifecycle.test";

integrationDescribe("PostgreSQL external identity lifecycle foundation", () => {
  let pool: ReturnType<typeof createPostgresPool>;

  beforeAll(async () => {
    pool = createPostgresPool({
      DATABASE_URL: databaseUrl!,
      DATABASE_SSL: "disable",
      DATABASE_POOL_MAX: "4",
      DATABASE_CONNECTION_TIMEOUT_MS: "5000",
      DATABASE_IDLE_TIMEOUT_MS: "1000",
      DATABASE_STATEMENT_TIMEOUT_MS: "5000"
    });
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  async function withIdentityTransaction<Result>(
    work: (transaction: IdentityTransaction) => Promise<Result>
  ): Promise<Result> {
    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN");
      open = true;
      const transaction: IdentityTransaction = {
        query: async <Row = Record<string, unknown>>(
          sql: string,
          values: readonly unknown[] = []
        ): Promise<readonly Row[]> => {
          const result = await client.query(sql, [...values]);
          return result.rows as Row[];
        }
      };
      const result = await work(transaction);
      await client.query("COMMIT");
      open = false;
      return result;
    } catch (error) {
      if (open) {
        try { await client.query("ROLLBACK"); } catch { /* discard on release */ }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  it("initializes every newly linked identity as active and records an append-only event", async () => {
    const subject = `subject-${randomUUID()}`;
    const identity = await withIdentityTransaction(async (transaction) => {
      const user = await createInternalUser(transaction);
      const linked = await linkExternalIdentity(transaction, user.id, issuer, subject);
      return linked.identity;
    });

    const lifecycle = await pool.query<{
      status: string;
      version: number;
      created_at: Date;
    }>(
      `SELECT status, version, created_at
         FROM user_external_identity_lifecycle
        WHERE identity_id = $1::uuid`,
      [identity.identityId]
    );
    expect(lifecycle.rows).toHaveLength(1);
    expect(lifecycle.rows[0]).toMatchObject({ status: "active", version: 1 });

    const events = await pool.query<{
      from_status: string | null;
      to_status: string;
      reason_code: string;
    }>(
      `SELECT from_status, to_status, reason_code
         FROM user_external_identity_lifecycle_events
        WHERE identity_id = $1::uuid`,
      [identity.identityId]
    );
    expect(events.rows).toEqual([
      { from_status: null, to_status: "active", reason_code: "identity_created" }
    ]);
  });

  it("does not grant the application role permission to mutate lifecycle state or audit history", async () => {
    const subject = `protected-${randomUUID()}`;
    const identity = await withIdentityTransaction(async (transaction) => {
      const user = await createInternalUser(transaction);
      const linked = await linkExternalIdentity(transaction, user.id, issuer, subject);
      return linked.identity;
    });

    await expect(pool.query(
      `UPDATE user_external_identity_lifecycle
          SET status = 'revoked'
        WHERE identity_id = $1::uuid`,
      [identity.identityId]
    )).rejects.toThrow();

    await expect(pool.query(
      `DELETE FROM user_external_identity_lifecycle_events
        WHERE identity_id = $1::uuid`,
      [identity.identityId]
    )).rejects.toThrow();
  });
});
