import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresPool } from "./postgres-pool.js";
import {
  createInternalUser,
  linkExternalIdentity,
  resolveExternalIdentity,
  type IdentityTransaction
} from "./internal-identities.js";

const databaseUrl = process.env.INFINYX_TEST_DATABASE_URL;
const integrationDescribe = databaseUrl ? describe : describe.skip;
const issuer = "https://infinyx.identity-lifecycle.test";

integrationDescribe("PostgreSQL external identity lifecycle foundation", () => {
  let pool: ReturnType<typeof createPostgresPool>;
  let adminPool: ReturnType<typeof createPostgresPool> | undefined;

  beforeAll(async () => {
    pool = createPostgresPool({
      DATABASE_URL: databaseUrl!,
      DATABASE_SSL: "disable",
      DATABASE_POOL_MAX: "4",
      DATABASE_CONNECTION_TIMEOUT_MS: "5000",
      DATABASE_IDLE_TIMEOUT_MS: "1000",
      DATABASE_STATEMENT_TIMEOUT_MS: "5000"
    });
    if (process.env.DATABASE_URL) {
      adminPool = createPostgresPool({
        DATABASE_URL: process.env.DATABASE_URL,
        DATABASE_SSL: "disable",
        DATABASE_POOL_MAX: "2",
        DATABASE_CONNECTION_TIMEOUT_MS: "5000",
        DATABASE_IDLE_TIMEOUT_MS: "1000",
        DATABASE_STATEMENT_TIMEOUT_MS: "5000"
      });
    }
  });

  afterAll(async () => {
    if (pool) await pool.end();
    if (adminPool) await adminPool.end();
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

  it("denies resolution after revocation and preserves append-only transition history", async () => {
    if (!adminPool) return;
    const subject = `revoked-${randomUUID()}`;
    const identity = await withIdentityTransaction(async (transaction) => {
      const user = await createInternalUser(transaction);
      const linked = await linkExternalIdentity(transaction, user.id, issuer, subject);
      return linked.identity;
    });

    for (const [status, reason] of [
      ["suspended", "integration_suspend"],
      ["active", "integration_reactivate"],
      ["revoked", "integration_revoke"]
    ] as const) {
      await adminPool.query(
        `UPDATE user_external_identity_lifecycle
            SET status = $2,
                version = version + 1,
                updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 millisecond'),
                status_change_reason = $3,
                status_change_correlation_id = $4::uuid
          WHERE identity_id = $1::uuid`,
        [identity.identityId, status, reason, randomUUID()]
      );
    }

    const resolved = await withIdentityTransaction((transaction) =>
      resolveExternalIdentity(transaction, issuer, subject)
    );
    expect(resolved).toBeNull();

    const events = await pool.query<{
      from_status: string | null;
      to_status: string;
      reason_code: string;
    }>(
      `SELECT from_status, to_status, reason_code
         FROM user_external_identity_lifecycle_events
        WHERE identity_id = $1::uuid
        ORDER BY created_at, event_id`,
      [identity.identityId]
    );
    expect(events.rows.map((event) => [event.from_status, event.to_status])).toEqual([
      [null, "active"],
      ["active", "suspended"],
      ["suspended", "active"],
      ["active", "revoked"]
    ]);

    await expect(adminPool.query(
      `UPDATE user_external_identity_lifecycle
          SET status = 'active',
              version = version + 1,
              updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 millisecond'),
              status_change_reason = 'invalid_reactivation',
              status_change_correlation_id = $2::uuid
        WHERE identity_id = $1::uuid`,
      [identity.identityId, randomUUID()]
    )).rejects.toThrow();

    const binding = await pool.query<{ user_id: string }>(
      `SELECT user_id::text AS user_id
         FROM user_external_identities
        WHERE identity_id = $1::uuid`,
      [identity.identityId]
    );
    expect(binding.rows[0]?.user_id).toBe(identity.userId);
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
