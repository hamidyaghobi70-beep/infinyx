# Memory boundary — Stage 4 controls and acceptance criteria

Status: **proposal for review; reference implementation only.** Nothing in this document
authorizes a persistent adapter, production use, merge, release, or deployment.

## Scope

Stage 4 of the [Core Engine roadmap](../engineering/core-engine-roadmap.md) requires the
storage controls below to have testable acceptance criteria before any persistence adapter
is implemented behind `MemoryPort`.

This change adds, without modifying the `MemoryPort` contract:

- `GuardedMemoryPort` (`src/core/guarded-memory-port.ts`): a decorator that enforces tenant
  isolation, policy authorization and audit around any `MemoryPort`.
- `InMemoryMemoryStore` (`src/core/in-memory-memory-store.ts`): a non-durable reference
  backing store for tests and local composition.
- `MemoryAccessError` (`src/core/memory-error.ts`): generic, non-leaking error type.

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
| M3 | Audit before effect | Implemented (in-process only) | At least one subscriber must be captured by atomic `publishIfSubscribed` dispatch; publication awaits that handler snapshot before the backing store is called, for allow and deny. It never contains the stored value. If no subscriber exists or a handler fails, allowed operations are refused (`MEMORY_AUDIT_UNAVAILABLE`); a denial stays a denial. This is not durable audit. |
| M4 | Input validation | Implemented | Empty, whitespace-only, control-character, over-long (namespace 128, key 256), lone-surrogate and non-string addresses are rejected before policy. Accepted addresses are never rewritten. Non-JSON values (undefined, function, symbol, bigint, circular, throwing `toJSON`) and values over the byte limit (default 64 KiB, measured in UTF-8 bytes) are rejected before policy. |
| M5 | No aliasing | Implemented | Mutating a value after `write`, or a value returned by `read`, never changes stored data. Backing stores only ever receive serialized strings. |
| M6 | Failure behavior | Implemented | Backend errors and corrupt backend data (non-string, invalid JSON) become `MEMORY_BACKEND_FAILED` with `cause` preserved and no internal detail in the message. Failure-event publication is best-effort and bounded by `auditTimeoutMs`, so a stalled subscriber cannot mask or indefinitely delay the original error. |
| M7 | Scope integrity | Implemented | Invalid scopes and dependencies fail at construction. The scope is snapshotted; later mutation of the caller's object has no effect. |
| M8 | Encryption at rest and in transit | **Not implemented** | Requires an approved design (see Decisions). `InMemoryMemoryStore` is plaintext and non-durable. |
| M9 | Key ownership and rotation | **Not implemented** | Requires an approved design and an owner decision on key custody. |
| M10 | Retention, deletion, backup | **Not implemented** | `delete` is an immediate hard delete in the reference store. No retention schedule, soft delete, legal hold or backup exists. |
| M11 | Durable audit | **Not implemented** | Events go to the in-process event bus. Durable, tamper-evident audit storage is a separate component. |
| M12 | Data classification | **Not implemented** | No classification labels exist. Namespaces and keys appear in audit events and policy resources, so they must not contain sensitive data. |
| M13 | Migration strategy | **Not implemented** | Stored values are canonical JSON strings with no schema version. A versioned envelope is needed before any durable adapter. |

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
- Audit publication awaits every handler, so a slow subscriber delays each operation up to
  `auditTimeoutMs`. Keep decision handlers fast and move slow work off the handler. Defaults are
  not based on load measurements; shorter deadlines can refuse legitimate slow work.
- Concurrent writes to the same address are last-write-wins. No compare-and-set exists.
- Audit events carry namespace and key (not values). Treat those as non-secret identifiers.

## Decisions required from the project owner before a persistent adapter

1. Storage technology and hosting (free/open-source preference and budget limits apply).
2. Encryption design and key custody, including rotation and loss-recovery policy (M8, M9).
3. Retention, deletion and backup rules, including any legal or regulatory requirements (M10).
4. Whether durable audit lives in the same store or a separate append-only system (M11).
5. The versioned value envelope and migration approach (M13).
6. Data classification scheme and which classes may be stored at all (M12).

## Review gate

Per the change protocol: independent review of the exact head commit is required, and no
merge to `main`, release or deployment is implied. Stage 5 (identity, agent runtime, tool
execution) remains disabled and out of scope.
