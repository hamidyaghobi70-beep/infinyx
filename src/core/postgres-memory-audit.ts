import { createHash } from "node:crypto";
import type {
  MemoryAccessDecidedEvent,
  MemoryAccessFailedEvent,
  MemoryAuditPort
} from "./guarded-memory-port.js";
import type { SqlQueryResult } from "./postgres-memory-store.js";

export interface AuditSqlConnection {
  query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<SqlQueryResult<Row>>;
  release(): void;
}
export interface AuditSqlPool {
  connect(): Promise<AuditSqlConnection>;
}

/**
 * Durable append-only audit sink. The database role used here should have INSERT
 * but no UPDATE/DELETE privileges on memory_access_events. Chain-head serialization
 * is protected by a row lock in the same transaction.
 */
export class PostgresMemoryAuditPort implements MemoryAuditPort {
  constructor(private readonly pool: AuditSqlPool) {}

  async publishDecision(event: MemoryAccessDecidedEvent): Promise<boolean> {
    await this.append("decision", event);
    return true;
  }

  async publishFailure(event: MemoryAccessFailedEvent): Promise<void> {
    await this.append("failure", event);
  }

  private async append(
    type: "decision" | "failure",
    event: MemoryAccessDecidedEvent | MemoryAccessFailedEvent
  ): Promise<void> {
    const connection = await this.pool.connect();
    try {
      await connection.query("BEGIN");
      const state = await connection.query<{ sequence: string | number; head_hash: string }>(
        "SELECT sequence, head_hash FROM infinyx_audit.audit_chain_state WHERE singleton = true FOR UPDATE"
      );
      const current = state.rows[0];
      if (!current) throw new Error("Audit chain state is missing.");
      const sequence = Number(current.sequence) + 1;
      if (!Number.isSafeInteger(sequence)) throw new Error("Audit sequence exceeded safe integer range.");
      const occurredAt = new Date().toISOString();
      const record = {
        sequence,
        type,
        actorId: event.actorId,
        tenantId: event.tenantId,
        moduleId: event.moduleId,
        operation: event.operation,
        namespace: event.namespace,
        key: event.key,
        // Store stable reason codes only; never persist policy prose or memory values.
        decision: type === "decision" ? (event as MemoryAccessDecidedEvent).decision : null,
        reasonCode: type === "decision"
          ? ((event as MemoryAccessDecidedEvent).decision === "allow" ? "POLICY_ALLOW" : "POLICY_DENY")
          : null,
        errorName: type === "failure" ? (event as MemoryAccessFailedEvent).errorName : null,
        occurredAt
      };
      const entryHash = createHash("sha256")
        .update(current.head_hash + JSON.stringify(record), "utf8")
        .digest("hex");
      await connection.query(
        `INSERT INTO infinyx_audit.memory_access_events
         (sequence, event_type, actor_id, tenant_id, module_id, operation, namespace, memory_key,
          decision, reason_code, error_name, occurred_at, previous_hash, entry_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          sequence, type, event.actorId, event.tenantId, event.moduleId, event.operation,
          event.namespace, event.key, record.decision, record.reasonCode, record.errorName,
          occurredAt, current.head_hash, entryHash
        ]
      );
      const headUpdate = await connection.query(
        "UPDATE infinyx_audit.audit_chain_state SET sequence = $1, head_hash = $2 WHERE singleton = true",
        [sequence, entryHash]
      );
      if (headUpdate.rowCount !== 1) {
        throw new Error("Audit chain head update did not affect exactly one row.");
      }
      await connection.query("COMMIT");
    } catch (error) {
      try { await connection.query("ROLLBACK"); } catch { /* preserve original failure */ }
      throw error;
    } finally {
      connection.release();
    }
  }
}
