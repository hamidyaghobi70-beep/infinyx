# Stage 4 PostgreSQL audit design

Status: **design proposal based on the project owner's selection of PostgreSQL; not an implementation or production approval.**

## Decision and scope

PostgreSQL is selected as the durable relational technology for the Stage 4 audit store. This decision selects the database technology only. It does not select a hosting provider, authorize production credentials or deployment, or settle encryption/key custody, retention, backup, or disaster-recovery policy.

This document specifies the minimum adapter contract and failure semantics before runtime code is added. It does not change `MemoryAuditPort`, `GuardedMemoryPort`, `MemoryPort`, or runtime behavior.

## Required semantic boundary

The audit store records **audit facts**, not proof that a memory side effect completed.

1. The caller creates a stable, random operation ID before the first audit submission. The ID is reused for retries of that same logical submission and is never reused for a different operation.
2. The adapter inserts the decision event and commits the PostgreSQL transaction before acknowledging acceptance.
3. A successful acknowledgement means the configured PostgreSQL commit completed. It does not mean the subsequent memory operation ran or succeeded.
4. If the caller's deadline expires before it receives the acknowledgement, the outcome is **unknown**. The caller must not infer rejection and must not mint a new operation ID for a retry.
5. A status lookup by operation ID determines whether the decision record exists. If the database is unavailable, the outcome remains unknown; it must not be converted to rejected or accepted.
6. The memory effect occurs only after the required allow-decision audit acknowledgement. A denial is recorded before the denial is returned.
7. A crash after the audit commit but before the memory effect leaves a recorded decision with no proven effect. A crash after the effect but before a completion record leaves the effect outcome unknown. Reconciliation must report these states honestly and must not automatically replay a memory write or delete.

The audit and memory effect are not claimed to be one atomic transaction. That would require a shared transactional boundary or a separately approved idempotent operation protocol.

## Logical data model

The initial schema should use two append-only tables:

### `memory_audit_operations`

- `operation_id UUID PRIMARY KEY`
- `tenant_id TEXT NOT NULL`
- `actor_id TEXT NOT NULL`
- `module_id TEXT NOT NULL`
- `operation TEXT NOT NULL` constrained to `read`, `write`, or `delete`
- `namespace TEXT NOT NULL`
- `key TEXT NOT NULL`
- `decision TEXT NOT NULL` constrained to `allow` or `deny`
- `reason TEXT NOT NULL`
- `payload_hash BYTEA NOT NULL` over a canonical representation of the immutable request fields
- `recorded_at TIMESTAMPTZ NOT NULL` assigned by the database

No stored memory value, credential, token, or secret may be placed in the audit row.

### `memory_audit_outcomes`

- `operation_id UUID NOT NULL REFERENCES memory_audit_operations(operation_id)`
- `event_id UUID NOT NULL UNIQUE` (stable identity for an outcome append)
- `sequence BIGINT NOT NULL`
- `outcome TEXT NOT NULL` constrained to the explicitly supported lifecycle values
- `recorded_at TIMESTAMPTZ NOT NULL` assigned by the database
- `details_code TEXT NULL` containing a bounded, non-sensitive classification only
- Primary key: `(operation_id, sequence)`

Outcome events are append-only. The first implementation must define and validate the allowed transition graph; it must not overwrite prior audit facts. At minimum, it must distinguish decision-recorded, effect-succeeded, effect-failed, and unresolved/unknown. A timeout itself is an observation by the caller, not proof of a database-side terminal outcome.

## Idempotency and conflict rules

- First submission of an operation ID inserts the immutable decision row.
- A repeated submission with the same operation ID and identical canonical payload returns the existing recorded result; it must not create a second logical decision.
- Reuse of an operation ID with a different payload is a hard conflict and must fail closed, with a security diagnostic that does not expose payload contents.
- Database uniqueness constraints, not process-local maps, enforce deduplication across concurrent requests and restarts.
- Outcome insertion uses a stable `event_id` UUID with a unique constraint. A transaction locks the parent operation row before checking the event identity and allocating the next sequence, serializing concurrent writers for that operation.

## Adapter API requirements

The durable adapter must expose explicit operations equivalent to:

- `recordDecision(operationId, event)`: commit-before-ack append; returns an acknowledgement containing the operation ID and committed record identity.
- `getOperation(operationId)`: read-only status lookup; distinguishes found, not found, and unavailable/error.
- `appendOutcome(operationId, outcome)`: append a validated outcome event idempotently.
- `listUnresolved(cursor, limit)`: bounded, ordered enumeration for reconciliation; no unbounded table scans in request paths.

The public API must not expose raw SQL, connection objects, or unrestricted audit mutation to modules. Only the composition root may construct the adapter and provide its capability to the guarded memory boundary.

## Transaction, timeout, and recovery rules

- Each append is a single database transaction. The acknowledgement is emitted only after commit resolves successfully.
- A client-side timeout does not cancel or roll back a transaction that may already have committed. The adapter must consume late promise settlement safely and retain the operation ID for lookup.
- A connection loss during COMMIT is an unknown outcome. Query by the same operation ID after connectivity returns; do not retry under a new ID.
- A missing row is conclusive only when queried against the authoritative database after connectivity is restored and the query completes successfully.
- Reconciliation is read-only in its first release. It may classify unresolved records and append an explicit reconciliation observation, but it must never replay memory side effects.
- PostgreSQL durability settings, replication guarantees, failover behavior, backup restore objectives, and the authoritative read endpoint must be documented and tested for the chosen host before any production durability claim.

## Security and operations gates

Before production use, the owner must approve:

1. Hosting/provider, environment separation, network access, availability target, and budget.
2. TLS in transit, encryption at rest, key custody, rotation, and recovery.
3. Retention period, deletion/legal-hold rules, backup schedule, restore testing, and data residency if applicable.
4. Access roles: application append/read permissions separated from migration/admin permissions; no update/delete permission for the runtime role.
5. Data classification for tenant, actor, module, namespace, key, and policy reason fields. These identifiers may themselves be sensitive.
6. Schema migration and rollback policy, including compatibility with existing audit records.

## Acceptance tests required before implementation is considered complete

1. Commit acknowledgement is not returned before the transaction commits.
2. Timeout followed by late commit is discoverable by the same operation ID.
3. Timeout followed by transaction rollback remains distinguishable from database unavailability.
4. Connection loss during commit is treated as unknown and resolved by lookup, not by a new operation ID.
5. Concurrent duplicate submissions create one logical decision row.
6. Same operation ID with different payload is rejected.
7. Process restart does not lose accepted rows or idempotency behavior.
8. Concurrent outcome appends preserve a valid, monotonic sequence.
9. Reconciliation never invokes memory read/write/delete and never automatically replays an operation.
10. Database unavailability, migration mismatch, and permission failure fail closed for allowed memory operations.
11. Audit rows never contain memory values or credentials.
12. Backup restore and configured durability behavior are verified against the selected hosting environment.

## Implementation gate

An isolated, non-production adapter prototype and initial SQL migration are now present on `feat/stage4-postgres-audit-adapter`, following explicit owner approval for experimental implementation. The prototype is intentionally not wired into `GuardedMemoryPort`; the current `MemoryAuditPort` contract has no operation ID and cannot satisfy this design. A follow-up contract change, real PostgreSQL integration tests, driver/configuration selection, least-privilege role verification, and the operational/security decisions above remain required before runtime integration or production use. The branch must remain non-main and its PR Draft until independent review and the project's merge authority requirements are satisfied.

No merge, release, deployment, production use, exactly-once claim, or crash-safe memory-side-effect guarantee is authorized by this design document.
