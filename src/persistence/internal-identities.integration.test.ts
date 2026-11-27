import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresPool } from "./postgres-pool.js";
import {
  createInternalUser,
  ExternalIdentityConflictError,
  linkExternalIdentity,
  resolveExternalIdentity,
  type IdentityTransaction
} from "./internal-identities.js";

const databaseUrl = process.env.INFINYX_TEST_DATABASE_URL;
const integrationDescribe = databaseUrl ? describe : describe.skip;
const issuer = "https://infinyx.identity-integration.test";

integrationDescribe("PostgreSQL internal identity integration", () => {
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
          try {
            const result = await client.query(sql, [...values]);
            return result.rows as Row[];
          } catch {
            throw new Error("Identity transaction failed");
          }
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

  it("creates independent internal users and links multiple external identities to one user", async () => {
    const suffix = randomUUID();
    const result = await withIdentityTransaction(async (transaction) => {
      const user = await createInternalUser(transaction);
      const secondUser = await createInternalUser(transaction);
      const firstLink = await linkExternalIdentity(transaction, user.id, issuer, `subject-${suffix}`);
      const secondLink = await linkExternalIdentity(
        transaction, user.id, "https://secondary.identity.test", `secondary-${suffix}`
      );
      const resolved = await resolveExternalIdentity(transaction, issuer, `subject-${suffix}`);
      return { user, secondUser, firstLink, secondLink, resolved };
    });

    expect(result.user.id).not.toBe(result.secondUser.id);
    expect(result.firstLink.outcome).toBe("linked");
    expect(result.secondLink.outcome).toBe("linked");
    expect(result.resolved?.userId).toBe(result.user.id);
  });

  it("prevents one external identity from being linked to two internal users", async () => {
    const suffix = randomUUID();
    await withIdentityTransaction(async (transaction) => {
      const first = await createInternalUser(transaction);
      const second = await createInternalUser(transaction);
      await linkExternalIdentity(transaction, first.id, issuer, `shared-${suffix}`);
      await expect(
        linkExternalIdentity(transaction, second.id, issuer, `shared-${suffix}`)
      ).rejects.toBeInstanceOf(ExternalIdentityConflictError);
    });
  });

  it("serializes concurrent attempts to claim the same external identity", async () => {
    const suffix = randomUUID();
    const [first, second] = await withIdentityTransaction(async (transaction) => [
      await createInternalUser(transaction),
      await createInternalUser(transaction)
    ]);
    const results = await Promise.allSettled([
      withIdentityTransaction((transaction) =>
        linkExternalIdentity(transaction, first.id, issuer, `race-${suffix}`)
      ),
      withIdentityTransaction((transaction) =>
        linkExternalIdentity(transaction, second.id, issuer, `race-${suffix}`)
      )
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.any(ExternalIdentityConflictError)
    });

    const lifecycle = await pool.query<{ status: string }>(
      `SELECT lifecycle.status
         FROM user_external_identities AS identity
         INNER JOIN user_external_identity_lifecycle AS lifecycle
           ON lifecycle.identity_id = identity.identity_id
        WHERE identity.issuer = $1 AND identity.subject = $2`,
      [issuer, `race-${suffix}`]
    );
    expect(lifecycle.rows).toEqual([{ status: "active" }]);
    const initialEvents = await pool.query<{ reason_code: string }>(
      `SELECT reason_code
         FROM user_external_identity_lifecycle_events AS event
         INNER JOIN user_external_identities AS identity
           ON identity.identity_id = event.identity_id
        WHERE identity.issuer = $1 AND identity.subject = $2`,
      [issuer, `race-${suffix}`]
    );
    expect(initialEvents.rows).toEqual([{ reason_code: "identity_created" }]);
  });

  it("keeps external identity records immutable and non-deletable to the app role", async () => {
    const suffix = randomUUID();
    const user = await withIdentityTransaction((transaction) => createInternalUser(transaction));
    await withIdentityTransaction((transaction) =>
      linkExternalIdentity(transaction, user.id, issuer, `immutable-${suffix}`)
    );
    await expect(pool.query(
      "UPDATE user_external_identities SET user_id = $1::uuid WHERE issuer = $2 AND subject = $3",
      [user.id, issuer, `immutable-${suffix}`]
    )).rejects.toThrow();
    await expect(pool.query(
      "DELETE FROM user_external_identities WHERE issuer = $1 AND subject = $2",
      [issuer, `immutable-${suffix}`]
    )).rejects.toThrow();
  });

  it("does not allow links to nonexistent internal users", async () => {
    await expect(withIdentityTransaction((transaction) =>
      linkExternalIdentity(
        transaction,
        "00000000-0000-4000-8000-000000000001",
        issuer,
        `orphan-${randomUUID()}`
      )
    )).rejects.toThrow();
  });
});
