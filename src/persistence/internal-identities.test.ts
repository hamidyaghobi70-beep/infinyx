import { describe, expect, it } from "vitest";
import {
  createInternalUser,
  ExternalIdentityConflictError,
  getInternalUser,
  linkExternalIdentity,
  resolveExternalIdentity
} from "./internal-identities.js";
import type { TenantTransaction } from "./tenant-transaction.js";

const userId = "9f1f0f40-2f4d-4c7a-8d5f-9f1f0f40a111";
const otherUserId = "8e2e0e30-1e3c-4b6a-9c4e-8e2e0e30a222";
const issuer = "https://id.example.test/realms/infinyx";
const subject = "provider-subject-123";

function transaction(handler: (sql: string, values: readonly unknown[]) => readonly unknown[]) {
  const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  const tx: TenantTransaction = {
    async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[] = []) {
      calls.push({ sql, values });
      return handler(sql, values) as readonly Row[];
    }
  };
  return { tx, calls };
}

const identityRow = {
  identity_id: "6d6d6d60-1111-4111-8111-111111111111",
  user_id: userId,
  issuer,
  subject,
  created_at: "2026-11-27T00:00:00.000Z"
};

describe("internal identity persistence", () => {
  it("creates an internal user with a generated stable UUID", async () => {
    const { tx, calls } = transaction((sql) => sql.includes("INSERT INTO users")
      ? [{ id: userId, created_at: "2026-11-27T00:00:00.000Z" }]
      : []);
    await expect(createInternalUser(tx)).resolves.toEqual({
      id: userId,
      createdAt: "2026-11-27T00:00:00.000Z"
    });
    expect(calls[0].values).toEqual([]);
  });

  it("resolves an external identity by exact issuer and subject", async () => {
    const { tx, calls } = transaction((sql) => sql.includes("FROM user_external_identities")
      ? [identityRow]
      : []);
    await expect(resolveExternalIdentity(tx, issuer, subject)).resolves.toMatchObject({
      userId,
      issuer,
      subject
    });
    expect(calls[0].values).toEqual([issuer, subject]);
  });

  it("returns null for an unknown external identity", async () => {
    const { tx } = transaction(() => []);
    await expect(resolveExternalIdentity(tx, issuer, "unknown-subject")).resolves.toBeNull();
  });

  it("creates a link only for the supplied internal user", async () => {
    const { tx, calls } = transaction((sql) => sql.includes("INSERT INTO user_external_identities")
      ? [identityRow]
      : []);
    await expect(linkExternalIdentity(tx, userId, issuer, subject)).resolves.toMatchObject({
      outcome: "linked",
      identity: { userId, issuer, subject }
    });
    expect(calls[0].sql).toContain("ON CONFLICT (issuer, subject) DO NOTHING");
    expect(calls[0].values).toEqual([userId, issuer, subject]);
  });

  it("does not reassign an identity already linked to another user", async () => {
    const { tx } = transaction((sql) => sql.includes("INSERT INTO user_external_identities")
      ? []
      : [{ ...identityRow, user_id: otherUserId }]);
    await expect(linkExternalIdentity(tx, userId, issuer, subject))
      .rejects.toBeInstanceOf(ExternalIdentityConflictError);
  });

  it("treats a repeated link to the same user as idempotent", async () => {
    const { tx } = transaction((sql) => sql.includes("INSERT INTO user_external_identities")
      ? []
      : [identityRow]);
    await expect(linkExternalIdentity(tx, userId, issuer, subject)).resolves.toMatchObject({
      outcome: "already_linked",
      identity: { userId }
    });
  });

  it("supports multiple provider identities for one internal user", async () => {
    const secondIssuer = "https://another-id.example.test";
    const { tx, calls } = transaction((sql) => sql.includes("INSERT INTO user_external_identities")
      ? [{ ...identityRow, issuer: secondIssuer }]
      : []);
    await expect(linkExternalIdentity(tx, userId, secondIssuer, "different-subject"))
      .resolves.toMatchObject({ outcome: "linked", identity: { userId, issuer: secondIssuer } });
    expect(calls[0].values).toEqual([userId, secondIssuer, "different-subject"]);
  });

  it("returns only an existing internal user and parameterizes its lookup", async () => {
    const { tx, calls } = transaction((sql) => sql.includes("FROM users")
      ? [{ id: userId, created_at: "2026-11-27T00:00:00.000Z" }]
      : []);
    await expect(getInternalUser(tx, userId)).resolves.toMatchObject({ id: userId });
    expect(calls[0].values).toEqual([userId]);
    await expect(getInternalUser(tx, "not-a-uuid")).resolves.toBeNull();
  });

  it("rejects insecure or malformed issuer values and empty subjects", async () => {
    const { tx, calls } = transaction(() => []);
    await expect(resolveExternalIdentity(tx, "http://id.example.test", subject)).rejects.toThrow(TypeError);
    await expect(resolveExternalIdentity(tx, "https://id.example.test?next=evil", subject)).rejects.toThrow(TypeError);
    await expect(resolveExternalIdentity(tx, issuer, "")).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });

  it("does not leak database errors", async () => {
    const tx: TenantTransaction = {
      async query<Row = Record<string, unknown>>() {
        throw new Error("sensitive database detail");
      }
    };
    await expect(resolveExternalIdentity(tx, issuer, subject))
      .rejects.toThrow("Internal identity operation failed");
  });
});
