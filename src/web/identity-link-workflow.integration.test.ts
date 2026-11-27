import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresPool } from "../persistence/postgres-pool.js";
import {
  completeIdentitySessionRevocation,
  registerVerifiedIdentityLink
} from "./identity-link-workflow.js";

const databaseUrl = process.env.INFINYX_TEST_DATABASE_URL;
const integrationDescribe = databaseUrl ? describe : describe.skip;

integrationDescribe("PostgreSQL immutable external identity link workflow", () => {
  let pool: ReturnType<typeof createPostgresPool>;
  let adminPool: ReturnType<typeof createPostgresPool>;

  beforeAll(() => {
    pool = createPostgresPool({
      DATABASE_URL: databaseUrl!,
      DATABASE_SSL: "disable",
      DATABASE_POOL_MAX: "6",
      DATABASE_CONNECTION_TIMEOUT_MS: "5000",
      DATABASE_IDLE_TIMEOUT_MS: "1000",
      DATABASE_STATEMENT_TIMEOUT_MS: "5000"
    });
    adminPool = createPostgresPool({
      DATABASE_URL: process.env.DATABASE_URL!,
      DATABASE_SSL: "disable",
      DATABASE_POOL_MAX: "3",
      DATABASE_CONNECTION_TIMEOUT_MS: "5000",
      DATABASE_IDLE_TIMEOUT_MS: "1000",
      DATABASE_STATEMENT_TIMEOUT_MS: "5000"
    });
  });

  afterAll(async () => {
    if (pool) await pool.end();
    if (adminPool) await adminPool.end();
  });

  it("adds a new binding without changing any existing identity or lifecycle history", async () => {
    const actor = randomUUID();
    const owner = randomUUID();
    const stranger = randomUUID();
    const issuer = `https://identity-${randomUUID()}.example.test`;
    const existingIssuer = `https://legacy-${randomUUID()}.example.test`;
    const existingSubject = `legacy-${randomUUID()}`;
    const newSubject = `new-${randomUUID()}`;
    const correlationId = randomUUID();

    await adminPool.query("INSERT INTO users (id) VALUES ($1::uuid), ($2::uuid), ($3::uuid)", [actor, owner, stranger]);
    const oldIdentity = await adminPool.query<{ identity_id: string }>(
      `INSERT INTO user_external_identities (user_id, issuer, subject)
       VALUES ($1::uuid, $2, $3) RETURNING identity_id::text AS identity_id`,
      [owner, existingIssuer, existingSubject]
    );
    const oldIdentityId = oldIdentity.rows[0]!.identity_id;
    const beforeIdentityRows = await adminPool.query(
      "SELECT identity_id::text, user_id::text, issuer, subject, created_at FROM user_external_identities ORDER BY identity_id"
    );
    const beforeLifecycle = await adminPool.query(
      "SELECT identity_id::text, status, version, created_at, updated_at FROM user_external_identity_lifecycle ORDER BY identity_id"
    );
    const beforeEvents = await adminPool.query(
      "SELECT event_id::text, identity_id::text, from_status, to_status, reason_code, created_at FROM user_external_identity_lifecycle_events ORDER BY event_id"
    );

      const result = await registerVerifiedIdentityLink(pool, actor, issuer, newSubject, correlationId);
      expect(result.outcome).toBe("linked");
      if (result.outcome !== "linked") throw new Error("Expected linked outcome.");

      const linked = await adminPool.query(
        "SELECT user_id::text FROM user_external_identities WHERE issuer = $1 AND subject = $2",
        [issuer, newSubject]
      );
      expect(linked.rows[0]?.user_id).toBe(actor);
      const newLifecycle = await adminPool.query(
        `SELECT lifecycle.status, lifecycle.version, event.reason_code
           FROM user_external_identities AS identity
           INNER JOIN user_external_identity_lifecycle AS lifecycle
             ON lifecycle.identity_id = identity.identity_id
           INNER JOIN user_external_identity_lifecycle_events AS event
             ON event.identity_id = identity.identity_id
          WHERE identity.issuer = $1 AND identity.subject = $2`,
        [issuer, newSubject]
      );
      expect(newLifecycle.rows).toEqual([{ status: "active", version: 1, reason_code: "identity_created" }]);

      const outbox = await adminPool.query(
        "SELECT user_id::text, completed_at FROM identity_session_revocation_outbox WHERE outbox_id = $1::uuid",
        [result.outboxId]
      );
      expect(outbox.rows[0]?.user_id).toBe(actor);
      expect(outbox.rows[0]?.completed_at).toBeNull();

      const again = await registerVerifiedIdentityLink(pool, actor, issuer, newSubject, randomUUID());
      expect(again.outcome).toBe("already_linked");

      const conflict = await registerVerifiedIdentityLink(pool, stranger, existingIssuer, existingSubject, randomUUID());
      expect(conflict.outcome).toBe("denied");

      const oldIdentityAfter = await adminPool.query(
        "SELECT identity_id::text, user_id::text, issuer, subject, created_at FROM user_external_identities WHERE identity_id = $1::uuid",
        [oldIdentityId]
      );
      expect(oldIdentityAfter.rows[0]).toMatchObject({
        identity_id: oldIdentityId, user_id: owner, issuer: existingIssuer, subject: existingSubject
      });
      const oldLifecycleAfter = await adminPool.query(
        "SELECT identity_id::text, status, version, created_at, updated_at FROM user_external_identity_lifecycle WHERE identity_id = $1::uuid",
        [oldIdentityId]
      );
      expect(oldLifecycleAfter.rows[0]).toMatchObject({
        identity_id: oldIdentityId, status: "active", version: 1
      });

      const oldEventsAfter = await adminPool.query(
        "SELECT event_id::text, identity_id::text, from_status, to_status, reason_code, created_at FROM user_external_identity_lifecycle_events WHERE identity_id = $1::uuid ORDER BY event_id",
        [oldIdentityId]
      );
      expect(oldEventsAfter.rows).toHaveLength(1);
      expect(oldEventsAfter.rows[0]?.to_status).toBe("active");

      const allIdentityRowsAfter = await adminPool.query(
        "SELECT identity_id::text, user_id::text, issuer, subject, created_at FROM user_external_identities WHERE identity_id = $1::uuid",
        [oldIdentityId]
      );
      expect(allIdentityRowsAfter.rows).toEqual(beforeIdentityRows.rows.filter(
        (row: { identity_id: string }) => row.identity_id === oldIdentityId
      ));
      const lifecycleBeforeOld = beforeLifecycle.rows.filter(
        (row: { identity_id: string }) => row.identity_id === oldIdentityId
      );
      expect(oldLifecycleAfter.rows).toEqual(lifecycleBeforeOld);
      const eventsBeforeOld = beforeEvents.rows.filter(
        (row: { identity_id: string }) => row.identity_id === oldIdentityId
      );
      expect(oldEventsAfter.rows).toEqual(eventsBeforeOld);

      const priorIdentityIds = beforeIdentityRows.rows.map((row: { identity_id: string }) => row.identity_id);
      const allPriorIdentitiesAfter = await adminPool.query(
        "SELECT identity_id::text, user_id::text, issuer, subject, created_at FROM user_external_identities WHERE identity_id = ANY($1::uuid[]) ORDER BY identity_id",
        [priorIdentityIds]
      );
      expect(allPriorIdentitiesAfter.rows).toEqual(beforeIdentityRows.rows);
      const allPriorLifecycleAfter = await adminPool.query(
        "SELECT identity_id::text, status, version, created_at, updated_at FROM user_external_identity_lifecycle WHERE identity_id = ANY($1::uuid[]) ORDER BY identity_id",
        [priorIdentityIds]
      );
      expect(allPriorLifecycleAfter.rows).toEqual(beforeLifecycle.rows);
      const allPriorEventsAfter = await adminPool.query(
        "SELECT event_id::text, identity_id::text, from_status, to_status, reason_code, created_at FROM user_external_identity_lifecycle_events WHERE identity_id = ANY($1::uuid[]) ORDER BY event_id",
        [priorIdentityIds]
      );
      expect(allPriorEventsAfter.rows).toEqual(beforeEvents.rows);
  });

  it("allows exactly one owner in concurrent attempts and never transfers the identity", async () => {
    const first = randomUUID();
    const second = randomUUID();
    const issuer = `https://race-${randomUUID()}.example.test`;
    const subject = `subject-${randomUUID()}`;
    await adminPool.query("INSERT INTO users (id) VALUES ($1::uuid), ($2::uuid)", [first, second]);
      const results = await Promise.all([
        registerVerifiedIdentityLink(pool, first, issuer, subject, randomUUID()),
        registerVerifiedIdentityLink(pool, second, issuer, subject, randomUUID())
      ]);
      expect(results.filter(result => result.outcome === "linked")).toHaveLength(1);
      expect(results.filter(result => result.outcome === "denied")).toHaveLength(1);
      const rows = await adminPool.query<{ user_id: string }>(
        "SELECT user_id::text AS user_id FROM user_external_identities WHERE issuer = $1 AND subject = $2",
        [issuer, subject]
      );
      expect(rows.rows).toHaveLength(1);
      expect([first, second]).toContain(rows.rows[0]?.user_id);
  });

  it("rolls back a newly inserted identity when the required audit write fails", async () => {
    const actor = randomUUID();
    const issuer = `https://rollback-${randomUUID()}.example.test`;
    const subject = `subject-${randomUUID()}`;
    const correlationId = randomUUID();
    await adminPool.query("INSERT INTO users (id) VALUES ($1::uuid)", [actor]);
    await adminPool.query(
      `INSERT INTO identity_security_audit_events
         (actor_user_id, event_type, reason_code, correlation_id)
       VALUES ($1::uuid, 'external_identity.link_denied', 'test_seed', $2::uuid)`,
      [actor, correlationId]
    );
      await expect(registerVerifiedIdentityLink(pool, actor, issuer, subject, correlationId)).rejects.toThrow();
      const rows = await adminPool.query(
        "SELECT 1 FROM user_external_identities WHERE issuer = $1 AND subject = $2",
        [issuer, subject]
      );
      expect(rows.rowCount).toBe(0);
  });
  it("keeps failed session revocation pending and only completes after confirmed revocation", async () => {
    const actor = randomUUID();
    const issuer = `https://outbox-${randomUUID()}.example.test`;
    const subject = `subject-${randomUUID()}`;
    await adminPool.query("INSERT INTO users (id) VALUES ($1::uuid)", [actor]);
    const linked = await registerVerifiedIdentityLink(pool, actor, issuer, subject, randomUUID());
    expect(linked.outcome).toBe("linked");
    if (linked.outcome !== "linked") throw new Error("Expected linked outcome.");

    const failedSessions = { revokeAllForUser: async () => { throw new Error("temporary failure"); } };
    expect(await completeIdentitySessionRevocation(
      pool, failedSessions as never, actor, linked.outboxId
    )).toBe(false);
    const pending = await adminPool.query(
      "SELECT completed_at, attempts, last_error_code FROM identity_session_revocation_outbox WHERE outbox_id = $1::uuid",
      [linked.outboxId]
    );
    expect(pending.rows[0]).toMatchObject({
      completed_at: null, attempts: 1, last_error_code: "session_revocation_failed"
    });

    const successfulSessions = { revokeAllForUser: async () => undefined };
    expect(await completeIdentitySessionRevocation(
      pool, successfulSessions as never, actor, linked.outboxId
    )).toBe(true);
    const completed = await adminPool.query(
      "SELECT completed_at, attempts, last_error_code FROM identity_session_revocation_outbox WHERE outbox_id = $1::uuid",
      [linked.outboxId]
    );
    expect(completed.rows[0]?.completed_at).toBeTruthy();
    expect(completed.rows[0]?.attempts).toBe(2);
    expect(completed.rows[0]?.last_error_code).toBeNull();
  });

});
