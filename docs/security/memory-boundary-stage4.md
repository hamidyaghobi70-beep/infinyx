# Memory boundary — Stage 4 controls and acceptance criteria

Status: **partial implementation on a draft branch; not production approved.** Nothing in this document
authorizes a persistent adapter, production use, merge, release, or deployment.

## Scope

Stage 4 of the [Core Engine roadmap](../engineering/core-engine-roadmap.md) requires the
storage controls below to have testable acceptance criteria before any persistence adapter
is implemented behind `MemoryPort`.

The guarded boundary and initial durable adapter implementation add, without modifying the `MemoryPort` contract:

- `GuardedMemoryPort` (`src/core/guarded-memory-port.ts`): a decorator that enforces tenant
  isolation, policy authorization and audit around any `MemoryPort`.
- `InMemoryMemoryStore` (`src/core/in-memory-memory-store.ts`): a non-durable reference
  backing store for tests and local composition.
- `MemoryAccessError` (`src/core/memory-error.ts`): generic, non-leaking error type.\n- `MemoryValueCipher` (`src/core/memory-encryption.ts`): AES-256-GCM envelope cipher backed by an injected key-provider contract.\n- `PostgresEncryptedMemoryStore` (`src/core/postgres-memory-store.ts`): encrypted PostgreSQL adapter with explicit expiry and bounded expiry sweep.\n- `PostgresMemoryAuditPort` (`src/core/postgres-memory-audit.ts`): transactional append-only audit writer with a serialized hash chain.\n- `migrations/0001_stage4_memory_audit.sql`: idempotent initial schema migration.

## Trust model

- `tenantId`, `actorId` and `moduleId` come from a `MemoryScope` supplied to the
  constructor. Core v1 has **no authentication**: the composition root must derive the
  scope from an authenticated principal (Stage 5). Modules must never construct or choose
  their own scope.
- The guard is a library component. `CoreEngineOptions.memory` is a module-id factory and
  Core Engine accepts only an actual `GuardedMemoryPort` whose bound `moduleId` matches
  the receiving module. Raw `MemoryPort` instances are rejected before module initialization.
  The composition root must still ensure that the factory derives tenant and actor identity
  from a trusted principal and never from module-supplied input.
- Audit is a separate `MemoryAuditPort`, not the module-visible `EventBusPort`. The
  composition root supplies this sink; modules receive neither the capability nor its
  registration interface. The sink must use trusted, access-controlled dispatch/storage.
  An in-process sink is still not durable.
- Module-to-module separation inside one tenant is not enforced by key prefix. It is a
  policy decision: the policy receives `moduleId` and `namespace` as attributes and the
  full `memory://` resource.

## Request pipeline

For `read`, `write` and `delete`, in this order:

1. Validate address (and value, for `write`). Failures never reach policy or the backend.
2. Evaluate policy for `memory.<operation>` on `memory://<tenant>/<namespace>/<key>`
   (each segment URL-encoded). Anything other than a well-formed explicit `allow` is a deny.
   Policy evaluation has a deadline (`policyTimeoutMs`, default 5000 ms); timeout is a deny.
3. Submit the decision record through the dedicated `MemoryAuditPort`, separate from the
   public module Event Bus, and await completion within `auditTimeoutMs` (default 5000 ms).
   A missing sink, false acknowledgement, failed publication or timeout refuses an allowed
   operation before the backing-store effect.
4. Call the backing store with a tenant-prefixed address and a canonical JSON string.
5. On backing-store failure, send a best-effort failure record through the dedicated
   audit sink within `auditTimeoutMs`, then raise `MEMORY_BACKEND_FAILED` even if the sink stalls.

## Controls

| # | Control | Status in this change | Acceptance criteria (verified by `test/core/guarded-memory-port.test.ts`) |
|---|---------|-----------------------|-------------------------------------------------------------------------|
| M1 | Tenant isolation | Implemented (logic) | Same `(namespace, key)` in two tenants sharing one store never observe each other's data, including after delete. Slash-containing tenant or namespace values cannot collide. The tenant prefix of backing addresses cannot be influenced by the module. |
| M2 | Default-deny authorization | Implemented | With `DefaultDenyPolicyEngine`, read/write/delete are refused and the backing store is never called. Policy errors and malformed decisions (null, string, array, wrong-case effect, missing or blank reason) are refused. The policy receives action, resource and attributes exactly as specified above. |
| M3 | Audit before effect | Implemented (in-process only) | A dedicated `MemoryAuditPort`, separate from the module-visible Event Bus, must acknowledge the decision record before the backing-store effect, for allow and deny. It never contains the stored value. If the sink is unavailable, rejects, returns false or times out, allowed operations are refused (`MEMORY_AUDIT_UNAVAILABLE`); a denial stays a denial. This is not durable audit. |
| M4 | Input validation | Implemented | Empty, whitespace-only, control-character, over-long (namespace 128, key 256), lone-surrogate and non-string addresses are rejected before policy. Accepted addresses are never rewritten. Non-JSON values (undefined, function, symbol, bigint, circular, throwing `toJSON`) and values over the byte limit (default 64 KiB, measured in UTF-8 bytes) are rejected before policy. |
| M5 | No aliasing | Implemented | Mutating a value after `write`, or a value returned by `read`, never changes stored data. Backing stores only ever receive serialized strings. |
| M6 | Failure behavior | Implemented | Backend errors and corrupt backend data (non-string, invalid JSON) become `MEMORY_BACKEND_FAILED` with `cause` preserved and no internal detail in the message. Failure-record publication through the dedicated sink is best-effort and bounded by `auditTimeoutMs`, so a stalled sink cannot mask or indefinitely delay the original error. |
| M7 | Scope integrity | Implemented | Invalid scopes and dependencies fail at construction. The scope is snapshotted; later mutation of the caller's object has no effect. |
| M8 | Encryption at rest and in transit | **Partial implementation** | AES-256-GCM envelope encryption is implemented behind an injected key provider. TLS is a deployment-level requirement, not enforced by this adapter. The production KMS provider is not implemented. |
| M9 | Key ownership and rotation | **Interface only** | `MemoryKeyProvider` requires active-key lookup and historical-key lookup; no cloud KMS adapter, key rotation workflow, or re-wrap migration is implemented. |
| M10 | Retention, deletion, backup | **Partial implementation** | PostgreSQL rows receive a configurable expiry (90-day default); reads reject expired rows and `deleteExpired` performs bounded hard-delete sweeps. Backup retention, deletion ledger/replay, and scheduled job orchestration remain unimplemented. |
| M11 | Durable audit | **Partial implementation** | A transactional PostgreSQL audit writer and hash chain are implemented. Database role provisioning, append-only grants, signed external checkpoints, and live integration are not implemented. |
| M12 | Data classification | **Partial implementation** | The PostgreSQL adapter requires explicit `public`, `internal`, or `confidential` classification and rejects missing/unknown/`restricted` values; the SQL schema enforces the same allow-list. Classification is not yet enforced by the general GuardedMemoryPort or every possible backend. |
| M13 | Migration strategy | **Partial implementation** | Encrypted records carry format, encryption, key, schema, and timestamp/expiry metadata. A resumable migration runner, progress ledger, and backup-compatible upgrade workflow remain unimplemented. |

## Known limitations

- `null` is a valid stored value and is indistinguishable from "missing" on read, as in the
  `MemoryPort` contract.
- Values are JSON data. Types JSON cannot represent are converted by `JSON.stringify`
  (for example `Date` becomes a string, `NaN` becomes `null`); only non-serializable values
  are rejected.
- The guard does not rate-limit or apply per-tenant quotas. A tenant can store unbounded
  entries; only per-value size is limited.
- Policy evaluation and audit publication have deadlines (`policyTimeoutMs` and `auditTimeoutMs`,
  default 5000 ms each; integer 1 to 2147483647). Neither is cancelled: a timed-out policy keeps
  running, and a timed-out audit handler may still complete and record the event after refusal.
- Backing-store calls have no deadline or cancellation in the guard; a store that never settles
  leaves the operation pending. Give production backends their own deadlines.
- Audit publication awaits the dedicated sink up to `auditTimeoutMs`. Keep the sink fast and
  move slow work off the request path. Defaults are not based on load measurements; shorter
  deadlines can refuse legitimate slow work.
- Concurrent writes to the same address are last-write-wins. No compare-and-set exists.
- Audit events carry namespace and key (not values). Treat those as non-secret identifiers.

## Owner decisions — resolved as an engineering baseline

The Founder delegated the six technical choices to the engineering coordinator, prioritizing the simplest, fastest, maintainable secure option. The decisions are recorded in [ADR-0001: Stage 4 persistent memory baseline](../architecture/decisions/adr-0001-stage4-persistent-memory.md).

Selected baseline:

1. PostgreSQL as the first durable backend; managed hosting for hosted deployments.
2. TLS plus application-layer AES-256-GCM envelope encryption; keys owned by an external KMS abstraction.
3. Default 90-day memory retention and 30-day encrypted backup retention, with deletion replay after restore.
4. Durable audit in a separate PostgreSQL schema with separate least-privilege roles, append-only writes, and externally stored signed checkpoints where available.
5. Canonical JSON inside a versioned envelope with resumable, idempotent forward migrations.
6. Explicit Public/Internal/Confidential/Restricted classification; Restricted data is denied, and unknown classification defaults to deny.

These are architecture decisions, **not evidence that the controls have been implemented**. The existing reference store remains in-memory and non-durable. No persistence adapter may be connected until trusted authenticated identity is available to the composition root and the implementation gates in ADR-0001 pass.
## Implementation progress on this draft branch

The initial adapter, cipher, audit writer, schema migration, and focused unit tests have been added. These are library components only. They have **not** been wired into `src/server.ts`, have not been tested against a live PostgreSQL service or cloud KMS, and have not passed CI on the exact current head. The SQL interfaces are structural so the repository does not yet take a dependency on a specific PostgreSQL driver.

Remaining blocking work includes: a production KMS provider and key-rotation procedure; DB role/grant provisioning and external audit checkpoints; classification enforcement across all MemoryPort implementations; backup/restore and deletion replay; authenticated identity composition; integration tests against PostgreSQL and a test KMS; and independent review. No real user data may be stored with this adapter until those gates pass.

## Review gate

Per the change protocol: independent review of the exact head commit is required, and no
merge to `main`, release or deployment is implied. Stage 5 (identity, agent runtime, tool
execution) remains disabled and out of scope.
