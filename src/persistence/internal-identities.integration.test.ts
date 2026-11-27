import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createJwtPrincipalVerifier } from "../core/authenticated-principal.js";
import { createPostgresPool, createTenantSqlPool } from "./postgres-pool.js";
import {
  createInternalUser,
  ExternalIdentityConflictError,
  linkExternalIdentity,
  resolveExternalIdentity
} from "./internal-identities.js";
import { withTenantTransaction } from "./tenant-transaction.js";

const databaseUrl = process.env.INFINYX_TEST_DATABASE_URL;
const integrationDescribe = databaseUrl ? describe : describe.skip;
const issuer = "https://infinyx.identity-integration.test";
const audience = "infinyx-identity-integration";

integrationDescribe("PostgreSQL internal identity integration", () => {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const verifier = createJwtPrincipalVerifier({
    issuer,
    audience,
    publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString()
  });
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = [
    encode({ alg: "RS256", typ: "JWT" }),
    encode({
      iss: issuer,
      aud: audience,
      sub: "user-tenant-a",
      tenant_id: "tenant-a",
      exp: Math.floor(Date.now() / 1000) + 600
    })
  ].join(".");
  const principal = verifier(
    unsigned + "." + sign("RSA-SHA256", Buffer.from(unsigned, "ascii"), keys.privateKey).toString("base64url")
  );

  let pool: ReturnType<typeof createPostgresPool>;
  let tenantPool: ReturnType<typeof createTenantSqlPool>;

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
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it("creates independent internal users and links multiple external identities to one user", async () => {
    const suffix = randomUUID();
    const result = await withTenantTransaction(tenantPool, principal, async (transaction) => {
      const user = await createInternalUser(transaction);
      const secondUser = await createInternalUser(transaction);
      const firstLink = await linkExternalIdentity(
        transaction, user.id, issuer, `subject-${suffix}`
      );
      const secondLink = await linkExternalIdentity(
        transaction, user.id, "https://secondary.identity.test", `secondary-${suffix}`
      );
      const resolved = await resolveExternalIdentity(
        transaction, issuer, `subject-${suffix}`
      );
      return { user, secondUser, firstLink, secondLink, resolved };
    });

    expect(result.user.id).not.toBe(result.secondUser.id);
    expect(result.firstLink.outcome).toBe("linked");
    expect(result.secondLink.outcome).toBe("linked");
    expect(result.resolved?.userId).toBe(result.user.id);
  });

  it("prevents one external identity from being linked to two internal users", async () => {
    const suffix = randomUUID();
    await withTenantTransaction(tenantPool, principal, async (transaction) => {
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
    const [first, second] = await withTenantTransaction(tenantPool, principal, async (transaction) => [
      await createInternalUser(transaction),
      await createInternalUser(transaction)
    ]);
    const results = await Promise.allSettled([
      withTenantTransaction(tenantPool, principal, (transaction) =>
        linkExternalIdentity(transaction, first.id, issuer, `race-${suffix}`)
      ),
      withTenantTransaction(tenantPool, principal, (transaction) =>
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
  });

  it("keeps external identity records immutable and non-deletable to the app role", async () => {
    const suffix = randomUUID();
    const user = await withTenantTransaction(tenantPool, principal, (transaction) =>
      createInternalUser(transaction)
    );
    await withTenantTransaction(tenantPool, principal, (transaction) =>
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
    await withTenantTransaction(tenantPool, principal, async (transaction) => {
      await expect(
        linkExternalIdentity(
          transaction,
          "00000000-0000-4000-8000-000000000001",
          issuer,
          `orphan-${randomUUID()}`
        )
      ).rejects.toThrow("Internal identity operation failed");
    });
  });
});
