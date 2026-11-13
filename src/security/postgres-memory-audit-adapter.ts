import { createHash } from "node:crypto";
import type { MemoryAccessDecidedEvent } from "../core/guarded-memory-port.js";

export type AuditOutcome =
  | "DECISION_RECORDED"
  | "EFFECT_SUCCEEDED"
  | "EFFECT_FAILED"
  | "UNRESOLVED";

export interface PgQueryResult<Row> {
  readonly rows: readonly Row[];
  readonly rowCount?: number | null;
}

export interface PgQueryable {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[]
  ): Promise<PgQueryResult<Row>>;
}

export interface PgClient extends PgQueryable {
  release(): void;
}

export interface PgPool {
  connect(): Promise<PgClient>;
}

export interface AuditDecisionAcknowledgement {
  readonly operationId: string;
  readonly recordedAt: string;
  readonly duplicate: boolean;
}

export type AuditLookupResult =
  | { readonly status: "found"; readonly operationId: string; readonly decision: "allow" | "deny"; readonly latestOutcome: AuditOutcome | null }
  | { readonly status: "not_found"; readonly operationId: string }
  | { readonly status: "unavailable"; readonly operationId: string };

export interface AuditOutcomeAcknowledgement {
  readonly operationId: string;
  readonly eventId: string;
  readonly sequence: string;
  readonly recordedAt: string;
  readonly duplicate: boolean;
}

export interface UnresolvedAuditOperation {
  readonly operationId: string;
  readonly decision: "allow" | "deny";
  readonly latestOutcome: AuditOutcome | null;
  readonly recordedAt: string;
}

export interface PostgresMemoryAuditAdapterOptions {
  readonly pool: PgPool;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OUTCOMES: readonly AuditOutcome[] = [
  "DECISION_RECORDED",
  "EFFECT_SUCCEEDED",
  "EFFECT_FAILED",
  "UNRESOLVED"
];

/**
 * PostgreSQL append-only audit adapter. It deliberately does not implement
 * MemoryAuditPort: the current guard contract has no operation ID, so wiring
 * this adapter into that runtime would erase the correlation guarantee.
 *
 * The supplied pool must be a trusted pg-compatible pool. Credentials and
 * pool construction belong to the composition root and are never accepted here.
 */
export class PostgresMemoryAuditAdapter {
  readonly #pool: PgPool;

  constructor(options: PostgresMemoryAuditAdapterOptions) {
    if (!options || !options.pool || typeof options.pool.connect !== "function") {
      throw new TypeError("A PostgreSQL-compatible pool is required.");
    }
    this.#pool = options.pool;
    Object.freeze(this);
  }

  async recordDecision(
    operationId: string,
    event: MemoryAccessDecidedEvent
  ): Promise<AuditDecisionAcknowledgement> {
    assertUuid(operationId, "operationId");
    validateDecisionEvent(event);
    const payloadHash = hashDecision(operationId, event);
    const client = await this.#pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      const inserted = await client.query<{ operation_id: string; recorded_at: Date | string }>(
        `INSERT INTO memory_audit_operations
          (operation_id, tenant_id, actor_id, module_id, operation, namespace, key,
           decision, reason, payload_hash)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, decode($10, 'hex'))
         ON CONFLICT (operation_id) DO NOTHING
         RETURNING operation_id, recorded_at`,
        [operationId, event.tenantId, event.actorId, event.moduleId, event.operation,
          event.namespace, event.key, event.decision, event.reason, payloadHash]
      );
      const existing = inserted.rows[0] ?? (await client.query<{
        operation_id: string;
        recorded_at: Date | string;
        payload_hash: Buffer | Uint8Array;
      }>(
        `SELECT operation_id, recorded_at, payload_hash
           FROM memory_audit_operations
          WHERE operation_id = $1::uuid
          FOR UPDATE`,
        [operationId]
      )).rows[0];

      if (!existing) throw new Error("Audit decision insert could not be confirmed.");
      const duplicate = inserted.rows.length === 0;
      if (duplicate && Buffer.from(existing.payload_hash).toString("hex") !== payloadHash) {
        throw new Error("Audit operation ID conflicts with a different immutable payload.");
      }

      await client.query("COMMIT");
      committed = true;
      return {
        operationId: existing.operation_id,
        recordedAt: normalizeTimestamp(existing.recorded_at),
        duplicate
      };
    } catch (error) {
      if (!committed) {
        try { await client.query("ROLLBACK"); } catch { /* Preserve the original failure. */ }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async getOperation(operationId: string): Promise<AuditLookupResult> {
    assertUuid(operationId, "operationId");
    try {
      const result = await this.#pool.connect();
      try {
        const query = await result.query<{
          operation_id: string;
          decision: "allow" | "deny";
          latest_outcome: AuditOutcome | null;
        }>(
          `SELECT op.operation_id, op.decision,
                  (SELECT outcome FROM memory_audit_outcomes
                    WHERE operation_id = op.operation_id
                    ORDER BY sequence DESC LIMIT 1) AS latest_outcome
             FROM memory_audit_operations op
            WHERE op.operation_id = $1::uuid`,
          [operationId]
        );
        const row = query.rows[0];
        return row
          ? { status: "found", operationId: row.operation_id, decision: row.decision, latestOutcome: row.latest_outcome }
          : { status: "not_found", operationId };
      } finally {
        result.release();
      }
    } catch {
      return { status: "unavailable", operationId };
    }
  }

  async appendOutcome(
    operationId: string,
    eventId: string,
    outcome: AuditOutcome,
    detailsCode?: string
  ): Promise<AuditOutcomeAcknowledgement> {
    assertUuid(operationId, "operationId");
    assertUuid(eventId, "eventId");
    if (!OUTCOMES.includes(outcome)) throw new TypeError("Unsupported audit outcome.");
    if (detailsCode !== undefined && (detailsCode.length > 96 || !/^[A-Z0-9_.-]+$/.test(detailsCode))) {
      throw new TypeError("detailsCode must be a bounded non-sensitive code.");
    }

    const client = await this.#pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      const parent = await client.query<{ operation_id: string }>(
        "SELECT operation_id FROM memory_audit_operations WHERE operation_id = $1::uuid FOR UPDATE",
        [operationId]
      );
      if (!parent.rows[0]) throw new Error("Cannot append an outcome for an unknown operation.");

      const prior = await client.query<{
        operation_id: string;
        event_id: string;
        sequence: string;
        outcome: AuditOutcome;
        details_code: string | null;
        recorded_at: Date | string;
      }>(
        "SELECT operation_id, event_id, sequence, outcome, details_code, recorded_at FROM memory_audit_outcomes WHERE event_id = $1::uuid",
        [eventId]
      );
      if (prior.rows[0]) {
        const row = prior.rows[0];
        if (row.operation_id !== operationId || row.outcome !== outcome || row.details_code !== (detailsCode ?? null)) {
          throw new Error("Audit event ID conflicts with a different immutable outcome.");
        }
        await client.query("COMMIT");
        committed = true;
        return { operationId, eventId, sequence: row.sequence, recordedAt: normalizeTimestamp(row.recorded_at), duplicate: true };
      }

      const latest = await client.query<{ outcome: AuditOutcome; sequence: string }>(
        "SELECT outcome, sequence FROM memory_audit_outcomes WHERE operation_id = $1::uuid ORDER BY sequence DESC LIMIT 1",
        [operationId]
      );
      validateTransition(latest.rows[0]?.outcome ?? null, outcome);
      const inserted = await client.query<{ sequence: string; recorded_at: Date | string }>(
        `INSERT INTO memory_audit_outcomes (operation_id, event_id, sequence, outcome, details_code)
         VALUES ($1::uuid, $2::uuid,
           COALESCE((SELECT MAX(sequence) + 1 FROM memory_audit_outcomes WHERE operation_id = $1::uuid), 1),
           $3, $4)
         RETURNING sequence, recorded_at`,
        [operationId, eventId, outcome, detailsCode ?? null]
      );
      const row = inserted.rows[0];
      if (!row) throw new Error("Audit outcome insert returned no row.");
      await client.query("COMMIT");
      committed = true;
      return { operationId, eventId, sequence: row.sequence, recordedAt: normalizeTimestamp(row.recorded_at), duplicate: false };
    } catch (error) {
      if (!committed) {
        try { await client.query("ROLLBACK"); } catch { /* Preserve the original failure. */ }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async listUnresolved(cursor: string | null = null, limit = 100): Promise<readonly UnresolvedAuditOperation[]> {
    if (cursor !== null) assertUuid(cursor, "cursor");
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new TypeError("limit must be an integer from 1 to 500.");
    }
    const client = await this.#pool.connect();
    try {
      const result = await client.query<{
        operation_id: string;
        decision: "allow" | "deny";
        latest_outcome: AuditOutcome | null;
        recorded_at: Date | string;
      }>(
        `SELECT op.operation_id, op.decision, latest.outcome AS latest_outcome, op.recorded_at
           FROM memory_audit_operations op
           LEFT JOIN LATERAL (
             SELECT outcome FROM memory_audit_outcomes
              WHERE operation_id = op.operation_id
              ORDER BY sequence DESC LIMIT 1
           ) latest ON TRUE
          WHERE ($1::uuid IS NULL OR op.operation_id > $1::uuid)
            AND (latest.outcome IS NULL OR latest.outcome = 'UNRESOLVED')
          ORDER BY op.operation_id
          LIMIT $2`,
        [cursor, limit]
      );
      return result.rows.map(row => ({
        operationId: row.operation_id,
        decision: row.decision,
        latestOutcome: row.latest_outcome,
        recordedAt: normalizeTimestamp(row.recorded_at)
      }));
    } finally {
      client.release();
    }
  }
}

function assertUuid(value: string, label: string): void {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a valid UUID.`);
  }
}

function validateDecisionEvent(event: MemoryAccessDecidedEvent): void {
  if (!event || !["read", "write", "delete"].includes(event.operation) ||
      !["allow", "deny"].includes(event.decision)) {
    throw new TypeError("Invalid memory audit decision event.");
  }
  for (const field of ["tenantId", "actorId", "moduleId", "namespace", "key", "reason"] as const) {
    const value = event[field];
    if (typeof value !== "string" || value.length === 0 || value.length > 512 || /[\\u0000-\\u001f\\u007f]/.test(value)) {
      throw new TypeError(`Invalid audit field: ${field}.`);
    }
  }
}

function hashDecision(operationId: string, event: MemoryAccessDecidedEvent): string {
  const canonical = JSON.stringify([
    operationId, event.tenantId, event.actorId, event.moduleId, event.operation,
    event.namespace, event.key, event.decision, event.reason
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function validateTransition(previous: AuditOutcome | null, next: AuditOutcome): void {
  const allowed: Readonly<Record<AuditOutcome | "NONE", readonly AuditOutcome[]>> = {
    NONE: ["DECISION_RECORDED", "UNRESOLVED"],
    DECISION_RECORDED: ["EFFECT_SUCCEEDED", "EFFECT_FAILED", "UNRESOLVED"],
    UNRESOLVED: ["EFFECT_SUCCEEDED", "EFFECT_FAILED"],
    EFFECT_SUCCEEDED: [],
    EFFECT_FAILED: []
  };
  if (!allowed[previous ?? "NONE"].includes(next)) {
    throw new Error("Invalid audit outcome transition.");
  }
}

function normalizeTimestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Database returned an invalid audit timestamp.");
  return date.toISOString();
}
