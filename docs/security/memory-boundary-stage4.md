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
- The guard is a library component. Isolation holds only if modules receive the guarded
  port and never the raw store.
- Module-to-module separation inside one tenant is not enforced by key prefix. It is a
  policy decision: the policy receives `moduleId` and `namespace` as attributes and the
  full `memory://` resource.

## Request pipeline

For `read`, `write` and `delete`, in this order:

1. Validate address (and value, for `write`). Failures never reach policy or the backend.
2. Evaluate policy for `memory.<operation>` on `memory://<tenant>/<namespace>/<key>`
   (each segment URL-encoded). Anything other than a well-formed explicit `allow` is a deny.
3. Publish `memory.access.decided` (see Audit). An allowed operation whose audit event
   cannot be published is refused.
4. Call the backing store with a tenant-prefixed address and a canonical JSON string.
5. On backing-store failure, publish `memory.access.failed` (best effort) and raise
   `MEMORY_BACKEND_FAILED`.

## Controls

| # | Control | Status in this change | Acceptance criteria (verified by `test/core/guarded-memory-port.test.ts`) |
|---|---------|-----------------------|-------------------------------------------------------------------------|
| M1 | Tenant isolation | Implemented (logic) | Same `(namespace, key)` in two tenants sharing one store never observe each other's data, including after delete. Slash-containing tenant or namespace values cannot collide. The tenant prefix of backing addresses cannot be influenced by the module. |
| M2 | Default-deny authorization | Implemented | With `DefaultDenyPolicyEngine`, read/write/delete are refused and the backing store is never called. Policy errors and malformed decisions (null, string, array, wrong-case effect, missing or blank reason) are refused. The policy receives action, resource and attributes exactly as specified above. |
| M3 | Audit before effect | Implemented (in-process only) | An audit event is published before the backing store is called, for allow and deny. It never contains the stored value. If the sink fails, allowed operations are refused (`MEMORY_AUDIT_UNAVAILABLE`); a denial stays a denial. |
| M4 | Input validation | Implemented | Empty, whitespace-only, control-character, over-long (namespace 128, key 256), lone-surrogate and non-string addresses are rejected before policy. Accepted addresses are never rewritten. Non-JSON values (undefined, function, symbol, bigint, circular, throwing `toJSON`) and values over the byte limit (default 64 KiB, measured in UTF-8 bytes) are rejected before policy. |
| M5 | No aliasing | Implemented | Mutating a value after `write`, or a value returned by `read`, never changes stored data. Backing stores only ever receive serialized strings. |
| M6 | Failure behavior | Implemented | Backend errors and corrupt backend data (non-string, invalid JSON) become `MEMORY_BACKEND_FAILED` with `cause` preserved, no internal detail in the message, and a failure event that cannot mask the original error. |
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
- Policy and backend calls have no per-operation timeout or cancellation here. Wrap the
  policy with `FailClosedPolicyEngine` (as `CoreEngine` already does for injected policies)
  and give production backends their own deadlines.
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
