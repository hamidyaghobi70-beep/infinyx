# Membership Lifecycle Implementation Design

- **Status:** Proposed technical design; not implementation authorization
- **Date:** 2026-11-27
- **Branch:** `feat/adr-platform-foundation`
- **Decision basis:** Accepted ADR-0007, ADR-0008, and ADR-0009
- **Scope:** Database and persistence design for membership lifecycle administration. No migration, runtime code, endpoint, UI, ownership-transfer flow, or deployment is included.

## 1. Goals and non-goals

This design translates the accepted membership lifecycle policies into a transaction-safe persistence plan.

It must enforce:

- Only an active, database-verified owner/admin may administer another membership in the same tenant.
- The administrative lifecycle API cannot suspend/remove the actor's own membership.
- The ordinary lifecycle API cannot suspend/remove a target whose current role is `owner`; owner-to-owner changes belong to a separate ownership-governance workflow.
- Only `active`, `suspended`, and `removed` are valid states. `removed` is terminal.
- A tenant must never lose its last active owner. Any future ownership/departure workflow must serialize the owner check and mutation.
- Successful state changes and their audit records are atomic.
- Re-invitation creates a new membership generation and never revives old branch assignments.
- Every authorization decision uses current database state in the same tenant transaction as the mutation.

Not included: invitation delivery/acceptance implementation, self-leave workflow, ownership transfer/governance, role changes, branch assignment implementation, HTTP endpoints, UI, audit-retention duration, or production rollout.

## 2. Current-state findings

The current `tenant_memberships` table has:

- Composite primary key `(tenant_id, user_id)`.
- A role column, but no lifecycle status.
- A tenant foreign key with `ON DELETE CASCADE`.
- No membership identity/generation for historical re-invitation.

The current `getTenantMembership` helper reads only `role`; it does not check lifecycle status. Branch assignments are not implemented yet, but the existing branch design anticipates a composite foreign key to `(tenant_id, user_id)`.

Consequently, a status column alone is insufficient to implement the accepted terminal-removal/new-generation rule while retaining historical membership records. The persistence model needs a stable membership-record identity.

## 3. Proposed membership data model

### 3.1 Membership record

Proposed target shape for `tenant_memberships`:

| Column | Proposed type | Purpose |
|---|---|---|
| `membership_id` | UUID, primary key | Stable identity of one membership lifecycle |
| `tenant_id` | text, not null | Tenant boundary |
| `user_id` | text, not null | Identity-provider subject |
| `generation` | integer, not null | Monotonically increasing lifecycle generation for this tenant/user |
| `role` | varchar(16), not null | Existing approved tenant role |
| `status` | varchar(16), not null | `active`, `suspended`, or `removed` |
| `created_at` | timestamptz, not null | Membership acceptance/creation time |
| `status_changed_at` | timestamptz, not null | Timestamp of latest status transition |
| `status_changed_by` | text, nullable | Actor subject for latest status transition; null for initial creation/system migration |
| `version` | bigint, not null | Monotonic optimistic-concurrency/version marker |

Recommended constraints and indexes:

1. Primary key on `membership_id`.
2. Unique key on `(tenant_id, membership_id)` for tenant-scoped foreign keys.
3. Unique key on `(tenant_id, user_id, generation)`.
4. Check `generation > 0` and `version > 0`.
5. Check role against the existing five-role allowlist.
6. Check status against exactly `active`, `suspended`, and `removed`.
7. Partial unique index on `(tenant_id, user_id)` where status is `active` or `suspended`. This allows historical removed generations but prevents two simultaneously current memberships for the same tenant/user.
8. Indexes supporting current membership lookup by `(tenant_id, user_id)` and audit/history lookup by tenant and membership.

A migration would backfill each existing row as generation 1 and status `active`, assign a new `membership_id`, and initialize version to 1. The migration must preserve every existing tenant/user/role association.

### 3.2 Why use membership identity plus generation?

A removed membership is terminal and must remain distinguishable from a later invitation accepted by the same person. Reusing the old row or merely changing `removed` back to `active` would violate ADR-0009 and could reconnect old grants.

The proposed model retains the removed row as history and inserts a new row with a new `membership_id` and next generation after a fresh invitation is accepted. At most one active/suspended generation exists for a tenant/user.

Generation allocation must not rely on an unlocked `MAX(generation) + 1`. The invitation-acceptance workflow must acquire the same tenant serialization lock described in Section 5, then allocate the next generation and insert the row. The unique constraint remains the final database guard.

### 3.3 Branch assignment relationship

When branch assignments are implemented, they should reference a specific `membership_id`, not only `(tenant_id, user_id)`. Include `tenant_id` in the assignment row and enforce composite foreign keys to both the tenant-scoped membership identity and branch identity.

This ensures assignments belong to one lifecycle generation. A fresh membership generation receives no assignments from a removed generation. Suspension may retain its own assignments as inert rows; reactivation restores only those still-valid assignments.

**Recommended retention choice:** retain assignment rows attached to the old membership generation as non-authorizing history, rather than deleting them during suspension/removal. This preserves auditability and avoids accidental reuse. Authorization must always require the referenced membership to be the current active generation. A later retention policy may archive/purge them under a separately approved process, without weakening audit requirements.

## 4. Audit event model

### 4.1 Append-only event record

Proposed table: `tenant_membership_audit_events`.

| Column | Proposed type | Purpose |
|---|---|---|
| `event_id` | UUID, primary key | Event identity |
| `tenant_id` | text, not null | Tenant boundary |
| `actor_user_id` | text, not null | Authenticated actor subject |
| `target_user_id` | text, not null | Target subject |
| `target_membership_id` | UUID, nullable | Exact generation, if resolved |
| `action` | text, not null | suspend/reactivate/remove |
| `previous_status` | text, nullable | State before attempted operation |
| `requested_status` | text, not null | Requested state |
| `outcome` | text, not null | succeeded/denied/noop |
| `reason_code` | text, not null | Stable internal reason; no raw exception |
| `correlation_id` | UUID, not null | Retry/idempotency correlation |
| `occurred_at` | timestamptz, not null | Database timestamp |

Use tenant-scoped RLS on the audit table. The application role should be granted INSERT and narrowly required SELECT only; it should not receive UPDATE or DELETE privileges. Retention and privileged audit-reader access remain separate governance decisions. Never store passwords, OTPs, access tokens, secrets, or unnecessary personal data.

### 4.2 Atomic successful operations

For an allowed state transition, update the membership and insert its audit event in the same database transaction. If the event insert fails, the transaction must roll back, leaving the membership state unchanged. A successful response is possible only after commit.

Use a unique constraint on `(tenant_id, correlation_id)` to prevent duplicate processing for a retried operation. On a repeated correlation ID, return the previously recorded outcome only if actor, target, and requested action match; otherwise reject it as an idempotency-key conflict.

### 4.3 Auditing denied and no-op attempts

ADR-0008 requires attempted lifecycle operations to be audited, while ADR-0009 requires state changes and successful transition events to be atomic.

To satisfy both without losing denial records to rollback, model expected authorization/validation denials as a normal result inside the transaction: insert a `denied` event, perform no mutation, commit the audit event, and only then return a generic authorization/transition error to the caller. If the audit insert fails, fail closed and do not report the operation as handled.

A same-state request should produce a stable `noop` result. It may have an operation audit event with outcome `noop`, but must not create a duplicate state-transition event or increment the membership version.

Unexpected database/connection failures may prevent durable database audit insertion. Such failures must still fail closed and raise a high-severity operational/security log/alert through the platform's independent observability path. Do not claim a durable audit event exists when the database could not commit it.

## 5. Transaction and concurrency protocol

### 5.1 Lock order

For MVP, serialize membership lifecycle mutations within a tenant by locking the tenant row first:

1. Start `withTenantTransaction` using the verified principal; transaction-local tenant context is established.
2. Lock the tenant row with a tenant-scoped `SELECT ... FOR UPDATE`.
3. Resolve and lock actor and target membership rows in deterministic order.
4. Re-check actor status and role from the database after locks are held.
5. Resolve target status and role from the database; never trust request/JWT role or status.
6. Validate the transition and ownership safeguards.
7. Update the membership with tenant, membership ID, expected prior status, and version predicates.
8. Insert the corresponding audit event.
9. Commit; only after commit return success.

All membership-creation/acceptance and future ownership-governance mutations must use the same tenant-first lock protocol. This tenant-row lock is intentionally coarse for the MVP; it is simple to reason about and prevents concurrent lifecycle operations from racing. If throughput later requires finer-grained locks, replace it only with an equivalently proven serialization design and concurrency tests.

### 5.2 Owner continuity

The ordinary lifecycle endpoint must reject a target whose current database role is `owner`, whether the actor is admin or owner. Owner-to-owner changes, ownership transfer, and owner departure are outside this endpoint and require a separate governance workflow.

The separate future workflow must lock the tenant row, re-check all relevant memberships after locking, and ensure at least one eligible active owner remains before committing any owner suspension/removal/transfer. A naive unlocked `COUNT(*)` is not sufficient. Concurrent attempts must serialize on the same tenant guard.

### 5.3 Actor and target safeguards

- Actor must be active and have database role owner/admin.
- Actor and target must be in the same tenant.
- Actor cannot target their own membership through this administrative API.
- Admin cannot target an owner.
- Ordinary lifecycle endpoint cannot target an owner at all.
- manager/editor/viewer cannot administer lifecycle.
- Target must be the current active/suspended generation, not an old removed generation.
- All predicates include tenant scope; RLS and DAL checks remain defense in depth.
- Missing, stale, cross-tenant, or inconsistent records fail closed with generic caller-facing errors.

### 5.4 Allowed transition matrix

| Current state | Requested state | Result |
|---|---|---|
| active | suspended | Allowed if actor/target safeguards pass |
| active | removed | Allowed if actor/target safeguards pass |
| suspended | active | Allowed if actor/target safeguards pass |
| suspended | removed | Allowed if actor/target safeguards pass |
| removed | any | Denied; fresh invitation creates a new generation |
| same state | same state | Stable no-op; no duplicate transition event |

Every real transition increments `version` exactly once and updates `status_changed_at` and `status_changed_by`. No-op does not increment version.

## 6. Authorization helper and repository changes

The current `getTenantMembership` helper must evolve to return membership identity, generation, role, status, and version. It must return an authorizing membership only when status is `active`; suspended, removed, or missing membership must fail closed.

The administrative repository should expose a narrow operation such as a lifecycle transition command, not a generic arbitrary status update. It should accept a verified principal, target selector, requested action, and correlation ID; it must not accept caller-supplied actor role, prior status, target role, or tenant authority.

All authorization and mutation must remain inside one `TenantTransaction`. Do not perform a membership check in one transaction and mutate in another. Keep SQL application-owned and parameterized.

## 7. Migration sequencing proposal

The eventual implementation should be split into reviewable steps:

1. **Schema expansion/backfill:** add membership identity, generation, status, status metadata, and version; backfill current rows; add checks and indexes.
2. **Audit foundation:** add append-only tenant-scoped audit events and least-privilege grants/RLS.
3. **Repository enforcement:** update membership reads to require active state; add transition repository with locks, transition matrix, idempotency, and atomic audit.
4. **Branch relationship alignment:** before implementing branch assignments, bind them to membership generation rather than user ID alone.
5. **Integration verification:** run the complete PostgreSQL suite under the least-privilege non-superuser, non-BYPASSRLS application role.

The existing tenant foreign key uses `ON DELETE CASCADE`. Before audit history is relied upon, tenant deletion must not cascade away membership/audit history. Prefer a separately governed tenant soft-delete/retention process and a restrictive FK for retained records. Do not implement destructive tenant deletion as part of this scope.

## 8. Required PostgreSQL integration tests

Use real PostgreSQL 16, RLS enabled and forced, and the least-privilege application role. At minimum:

1. Existing memberships are backfilled as generation 1 and active.
2. Active member authorization succeeds; suspended/removed/missing membership fails closed.
3. Only active owner/admin can administer a different member in the same tenant.
4. manager/editor/viewer are denied.
5. Self-suspend/self-remove is denied.
6. Admin cannot suspend/remove an owner.
7. Ordinary endpoint rejects owner targets, including owner-to-owner.
8. Last active owner remains protected; future owner-governance tests prove transfer-before-departure.
9. All four allowed transitions work; removed-to-any is denied.
10. Same-state requests are stable no-ops and do not duplicate transition events or increment version.
11. Audit insert failure rolls back a successful state mutation.
12. Denied attempts are recorded without changing membership state.
13. Retrying the same correlation ID does not duplicate the operation/event; mismatched reuse is rejected.
14. Concurrent tenant lifecycle operations serialize; no race can remove/suspend all active owners in any future owner-governance path.
15. A removed membership remains historical; fresh invitation acceptance creates a new membership ID and next generation.
16. Old-generation branch assignments cannot authorize the new generation.
17. Cross-tenant targets, stale generations, and client-supplied tenant/role/status claims cannot authorize an operation.
18. Tenant context does not leak across pooled connections.
19. Audit and membership tables enforce tenant RLS; app role is not superuser and lacks BYPASSRLS.
20. Audit rows cannot be updated/deleted by the application role.
21. Tenant deletion cannot cascade-delete retained membership/audit history.

## 9. Security limitations and open governance decisions

The current `app.tenant_id` custom GUC is transaction-local but not cryptographically authenticated. RLS is defense in depth against omitted tenant predicates/repository mistakes, not protection against arbitrary SQL execution or successful SQL injection. Parameterized SQL, trusted query text, least privilege, and independent security review remain mandatory. A stronger authenticated tenant-context design must be evaluated before production.

Still requiring separate decisions/design before enabling broader functionality:

- Audit retention duration, archival, and privileged reader access.
- Tenant deletion/closure and legal retention semantics.
- Invitation lifecycle, expiry, acceptance, and identity-linking rules.
- Ownership transfer and self-leave workflows.
- Whether assignment archival/purge is ever permitted and under what retention controls.
- API-level rate limiting and abuse monitoring for lifecycle administration.

## 10. Implementation gate

This document is a technical proposal only. It does not authorize code, migrations, endpoints, UI, merge, release, or deployment.

Before implementation, obtain explicit founder approval for the concrete scope: migration/backfill, audit schema, repository changes, and PostgreSQL integration tests. Keep all approved work on `feat/adr-platform-foundation`; keep `main` unchanged. No merge, release, or deployment is authorized.
