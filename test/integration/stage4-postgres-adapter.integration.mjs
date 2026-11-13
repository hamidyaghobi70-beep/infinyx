import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PostgresMemoryAuditAdapter } from "../../dist/security/postgres-memory-audit-adapter.js";

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;
assert.ok(connectionString, "DATABASE_URL is required");

const pool = new Pool({ connectionString, max: 8 });
const adapter = new PostgresMemoryAuditAdapter({ pool });
const ids = {
  duplicate: randomUUID(),
  ambiguous: randomUUID(),
  concurrent: randomUUID(),
  denied: randomUUID(),
  pageFirst: "30000000-0000-4000-8000-000000000001",
  pageSecond: "30000000-0000-4000-8000-000000000002",
  resolvedList: "30000000-0000-4000-8000-000000000003",
  deniedList: "30000000-0000-4000-8000-000000000004"
};
const decision = {
  tenantId: "tenant-integration",
  actorId: "actor-integration",
  moduleId: "module-integration",
  operation: "write",
  namespace: "profile",
  key: "display-name",
  decision: "allow",
  reason: "integration-test"
};

async function cleanup() {
  await pool.query(
    "DELETE FROM memory_audit_outcomes WHERE operation_id = ANY($1::uuid[])",
    [Object.values(ids)]
  );
  await pool.query(
    "DELETE FROM memory_audit_operations WHERE operation_id = ANY($1::uuid[])",
    [Object.values(ids)]
  );
}

try {
  await cleanup();

  // Same operation ID + same immutable payload is idempotent.
  const first = await adapter.recordDecision(ids.duplicate, decision);
  const second = await adapter.recordDecision(ids.duplicate, decision);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal((await adapter.getOperation(ids.duplicate)).latestOutcome, "DECISION_RECORDED");

  // Same operation ID with a different payload must be rejected.
  await assert.rejects(
    adapter.recordDecision(ids.duplicate, { ...decision, reason: "different-payload" }),
    /conflicts with a different immutable payload/
  );

  // Concurrent submissions with one operation ID create one durable row.
  const concurrentResults = await Promise.all([
    adapter.recordDecision(ids.concurrent, decision),
    adapter.recordDecision(ids.concurrent, decision),
    adapter.recordDecision(ids.concurrent, decision)
  ]);
  assert.equal(concurrentResults.filter(result => !result.duplicate).length, 1);
  assert.equal(concurrentResults.filter(result => result.duplicate).length, 2);
  const operationCount = await pool.query(
    "SELECT count(*)::int AS count FROM memory_audit_operations WHERE operation_id = $1::uuid",
    [ids.concurrent]
  );
  assert.equal(operationCount.rows[0].count, 1);

  // Outcome appends are idempotent by event ID and follow the allowed state graph.
  const unresolvedEventId = randomUUID();
  const unresolved = await adapter.appendOutcome(ids.concurrent, unresolvedEventId, "UNRESOLVED");
  const unresolvedRetry = await adapter.appendOutcome(ids.concurrent, unresolvedEventId, "UNRESOLVED");
  assert.equal(unresolved.sequence, "2");
  assert.equal(unresolved.duplicate, false);
  assert.equal(unresolvedRetry.duplicate, true);
  assert.equal((await adapter.getOperation(ids.concurrent)).latestOutcome, "UNRESOLVED");

  const succeeded = await adapter.appendOutcome(ids.concurrent, randomUUID(), "EFFECT_SUCCEEDED");
  assert.equal(succeeded.sequence, "3");
  assert.equal((await adapter.getOperation(ids.concurrent)).latestOutcome, "EFFECT_SUCCEEDED");

  // Denied decisions cannot receive memory-effect outcomes.
  await adapter.recordDecision(ids.denied, { ...decision, decision: "deny" });
  await assert.rejects(
    adapter.appendOutcome(ids.denied, randomUUID(), "EFFECT_SUCCEEDED"),
    /denied memory operation/
  );

  // Unresolved listing is bounded, ordered, cursor-resumable, and excludes terminal/denied records.
  // Remove earlier fixtures so the expected page boundary is deterministic.
  await cleanup();
  await adapter.recordDecision(ids.pageFirst, decision);
  await adapter.recordDecision(ids.pageSecond, decision);
  await adapter.recordDecision(ids.resolvedList, decision);
  await adapter.appendOutcome(ids.resolvedList, randomUUID(), "EFFECT_SUCCEEDED");
  await adapter.recordDecision(ids.deniedList, { ...decision, decision: "deny" });

  const firstPage = await adapter.listUnresolved(null, 1);
  assert.equal(firstPage.length, 1);
  assert.equal(firstPage[0].operationId, ids.pageFirst);
  assert.equal(firstPage[0].latestOutcome, "DECISION_RECORDED");

  const secondPage = await adapter.listUnresolved(firstPage[0].operationId, 1);
  assert.equal(secondPage.length, 1);
  assert.equal(secondPage[0].operationId, ids.pageSecond);

  const afterSecondPage = await adapter.listUnresolved(secondPage[0].operationId, 1);
  assert.equal(afterSecondPage.length, 0);
  await assert.rejects(adapter.listUnresolved("not-a-uuid", 1), /valid UUID/);
  await assert.rejects(adapter.listUnresolved(null, 0), /limit must be an integer/);
  await assert.rejects(adapter.listUnresolved(null, 501), /limit must be an integer/);

  // Simulate the client losing the acknowledgement after PostgreSQL committed.
  let commitAcknowledgementLost = false;
  const ambiguousPool = {
    async connect() {
      const client = await pool.connect();
      return {
        async query(sql, values) {
          const result = await client.query(sql, values);
          if (sql.trim().toUpperCase() === "COMMIT" && !commitAcknowledgementLost) {
            commitAcknowledgementLost = true;
            throw new Error("simulated connection loss after server-side commit");
          }
          return result;
        },
        release() { client.release(); }
      };
    }
  };
  const ambiguousAdapter = new PostgresMemoryAuditAdapter({ pool: ambiguousPool });
  await assert.rejects(
    ambiguousAdapter.recordDecision(ids.ambiguous, decision),
    /simulated connection loss/
  );

  const reconciled = await adapter.getOperation(ids.ambiguous);
  assert.equal(reconciled.status, "found");
  assert.equal(reconciled.latestOutcome, "DECISION_RECORDED");

  // Retrying with the exact same operation ID confirms the committed record.
  const retry = await adapter.recordDecision(ids.ambiguous, decision);
  assert.equal(retry.duplicate, true);

  // A fresh adapter instance can recover the persisted operation after restart.
  const restartedAdapter = new PostgresMemoryAuditAdapter({ pool });
  assert.equal((await restartedAdapter.getOperation(ids.ambiguous)).status, "found");

  console.log("Stage 4 PostgreSQL adapter integration checks passed");
} finally {
  await cleanup();
  await pool.end();
}
