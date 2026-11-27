# Tenant Invitation and Acceptance — Implementation Design

**Status:** Design approved; implementation not yet authorized  
**Decision:** ADR-0010  
**Decision owner:** INFINYX founder  
**Default invitation lifetime:** 72 hours  
**Scope:** Persistence, identity proof, invitation state transitions, acceptance, audit, and verification design

## 1. Purpose and implementation boundary

This document translates ADR-0010 into an implementation-ready design. It is not a claim that invitation functionality exists. The current branch has membership lifecycle persistence, but no invitation table, invitation repository, identity verification adapter, delivery adapter, API endpoint, or UI.

All future implementation must remain on `feat/adr-platform-foundation`. Keep `main` unchanged. A separate founder approval is required before code changes. No merge, release, or deployment is authorized.

## 2. Existing foundations and constraints

The current repository provides:
- Tenant-scoped PostgreSQL transactions and RLS.
- `tenant_memberships` with `membership_id`, `generation`, `role`, `status`, and optimistic `version`.
- A partial unique index allowing only one current `active` or `suspended` membership per tenant/user.
- A tenant-first row-lock pattern for membership lifecycle mutations.
- Append-only, tenant-scoped membership lifecycle audit records.
- Current roles: `owner`, `admin`, `manager`, `editor`, `viewer`.

Important limitations:
- The current tenant GUC is defense in depth, not cryptographically authenticated.
- No production identity provider has been selected.
- No verified email/phone assertion contract is currently implemented.
- Branch tables and branch assignments are not implemented.
- Current code is not production-ready and has not undergone independent security review.

## 3. Proposed data model

### 3.1 `tenant_invitations`

Proposed columns:

| Column | Type | Purpose |
|---|---|---|
| `invitation_id` | UUID PK | Invitation identity |
| `tenant_id` | text NOT NULL | Tenant boundary |
| `identity_type` | text/enum NOT NULL | `email` or `phone` |
| `normalized_identity` | text NOT NULL | Canonical target identity |
| `identity_fingerprint` | bytea NOT NULL | Keyed fingerprint for lookup/deduplication without indexing raw identity |
| `token_hash` | bytea NOT NULL | One-way hash of high-entropy token |
| `role` | text NOT NULL | `admin`, `manager`, `editor`, or `viewer` |
| `status` | text NOT NULL | `pending`, `accepted`, `revoked`, `expired` |
| `invited_by` | text NOT NULL | Actor subject |
| `created_at` | timestamptz NOT NULL | Database creation time |
| `expires_at` | timestamptz NOT NULL | Creation time plus 72 hours |
| `accepted_by` | text NULL | Authenticated account subject |
| `accepted_at` | timestamptz NULL | Acceptance time |
| `revoked_by` | text NULL | Revoking actor |
| `revoked_at` | timestamptz NULL | Revocation time |
| `correlation_id` | UUID NOT NULL | Operation/idempotency correlation |
| `version` | bigint NOT NULL | Concurrency/version guard |

Design constraints:
- Foreign key to tenant with deletion restricted, consistent with retained membership/audit history.
- Check constraints for identity type, role allowlist (excluding `owner`), status allowlist, valid expiry, and state metadata consistency.
- Unique token hash.
- Index pending invitations by tenant and identity fingerprint for controlled lookup.
- RLS ENABLE and FORCE with tenant-scoped policy.
- Application role receives only the minimum required SELECT/INSERT and narrowly scoped UPDATE columns. No application UPDATE/DELETE of audit rows.
- Avoid storing raw identity in general-purpose logs. Whether the normalized identity is encrypted at rest or stored in a separately protected identity vault must be decided during implementation security review. The keyed fingerprint must use a managed secret and support rotation.

A partial unique index for one pending invitation per tenant and identity may be used, but its exact semantics must account for expiration. An expired-but-not-yet-materialized row must not block a new invitation indefinitely. Use transaction-time expiry resolution plus a safe uniqueness strategy; do not rely on a time-dependent partial-index predicate.

### 3.2 `tenant_invitation_audit_events`

Proposed append-only audit table:
- `event_id` UUID primary key
- `tenant_id`
- `invitation_id` (nullable only for attempts where no invitation can safely be resolved)
- `actor_user_id` (nullable for unauthenticated attempts)
- `action` (created, revoked, accepted, expired, acceptance_denied, replay_denied)
- `previous_status`, `new_status`
- `outcome`, stable `reason_code`
- `correlation_id`
- `occurred_at`

Do not store raw invitation tokens, OTPs, passwords, full verification payloads, or unnecessary personal data. Apply RLS ENABLE/FORCE and tenant scope. Application role cannot UPDATE/DELETE audit rows. Define retention and privileged audit access separately.

## 4. Identity verification contract

Acceptance must receive a trusted, server-validated identity assertion from the selected authentication/identity layer. The future adapter contract should provide:
- authenticated account subject;
- verified identity type;
- canonical verified identity value or protected stable identity reference;
- verification status and verification timestamp;
- issuer/audience or equivalent trust metadata where applicable.

The adapter must validate issuer, audience, signature/cryptographic integrity, expiry, and account binding according to the selected provider. Do not accept client-supplied `verified=true`, raw email/phone, or user ID as proof.

The invitation service compares the trusted verified identity with the invitation's target identity using the same canonicalization rules used at invitation creation. Email normalization and phone normalization must be deterministic and versioned; phone parsing must use an explicit country context rather than guessing. The provider and exact assertion schema remain implementation prerequisites.

If the invitee is new, registration and verification happen before acceptance. If the invitee already has an account, they authenticate and prove control of the invited identity. Account linking remains exclusively within the trusted identity provider workflow.

## 5. Token handling

1. Generate a high-entropy random token using a cryptographically secure random generator.
2. Return the raw token only to the delivery adapter for the intended recipient; never return it in general API responses or logs.
3. Store only a one-way hash using a suitable password/token hashing construction. Since tokens are high entropy, use a cryptographic hash with a server-side pepper or keyed HMAC; store key version metadata for rotation.
4. Verify candidates using constant-time comparison.
5. Bind token hash to one invitation and tenant; use unique constraints to prevent reuse.
6. Redact token-bearing URLs and request fields from logs, traces, analytics, and error reporting.
7. Rate-limit token checks and acceptance attempts by relevant combinations of IP/device, invitation, and account while avoiding account enumeration.

The final hash/pepper strategy and secret-management mechanism must be confirmed during implementation review.

## 6. Authorization and creation flow

Within one tenant-scoped transaction:
1. Lock the tenant row first, following the existing membership lifecycle lock order.
2. Resolve and lock the actor's latest membership row.
3. Re-check that actor is active and DB role is `owner` or `admin`.
4. Normalize and validate exactly one target identity.
5. Resolve target account/membership only through trusted server-side identity references; do not trust caller-supplied account linkage.
6. Reject creation if the target already has active or suspended membership.
7. If the latest generation is removed, permit a new invitation for a later generation; do not mutate the old membership.
8. Enforce invitation role allowlist; reject `owner`.
9. Resolve any prior pending invitation for the same tenant/identity under lock. Require explicit, audited handling (revoke/replace) rather than silently issuing multiple live tokens.
10. Insert invitation, token hash, expiry (`now() + interval '72 hours'`), and audit event atomically.
11. Commit before dispatching delivery through an outbox/adapter pattern.

The exact policy for an existing pending invitation should be deterministic: recommended behavior is to reject duplicate creation with a generic conflict unless an authorized explicit resend/replacement action revokes the old invitation and creates a new record in one transaction. Resend must not extend an existing token's expiry silently.

## 7. Revocation flow

Within one tenant-scoped transaction:
1. Lock tenant row first.
2. Verify active DB-backed owner/admin actor.
3. Lock the target invitation.
4. Verify tenant scope and current status.
5. Revoke only a pending invitation; accepted/revoked/expired records are terminal.
6. Write audit event in the same transaction.
7. Commit before acknowledging success.

A same-operation retry must be idempotent. Do not expose cross-tenant invitation existence.

## 8. Acceptance flow

Acceptance is one atomic tenant-scoped transaction:
1. Authenticate the caller and validate the trusted identity assertion before opening the acceptance transaction.
2. Resolve token candidate to an invitation using a protected lookup path that does not disclose invitation existence. Establish tenant context only from a trusted invitation resolution, never from client tenant input.
3. Start the tenant transaction and lock the tenant row first.
4. Lock the invitation row and re-check token hash, tenant, status, and database expiry.
5. If pending but expired, transition to `expired`, write audit, commit the expiry resolution, and return a generic non-acceptance result.
6. If not pending, reject replay/terminal state without creating a membership.
7. Verify the trusted identity assertion matches the exact invited identity.
8. Resolve the authenticated account's latest membership generation in the tenant and lock relevant rows.
9. Reject if a current active or suspended membership exists.
10. Re-check invitation role and all invariants under lock.
11. Insert a new `tenant_memberships` row with a new UUID `membership_id`, generation 1 if no history exists or latest generation + 1 if latest is removed, invitation role, and `active` status.
12. Update invitation to `accepted` with `accepted_by` and `accepted_at`, guarded by current pending state/version.
13. Insert success audit event.
14. Commit; only after commit return success.

All membership creation paths must share the tenant-first serialization protocol. The existing partial unique index remains a final guard against concurrent current memberships. The unique `(tenant_id,user_id,generation)` constraint protects generation uniqueness. Any failure to create membership, consume invitation, or write required audit rolls back the entire acceptance.

### 8.1 Tenant resolution and RLS design gate

A token-only unauthenticated lookup cannot simply trust a client-supplied tenant ID to establish `app.tenant_id`. The implementation must provide a reviewed bootstrap resolution mechanism that maps a valid token hash to a tenant/invitation without granting general tenant data access. Options include a narrowly privileged security-definer function with a fixed safe search_path and minimal return shape, or a separate invitation lookup boundary. This mechanism requires security review; do not weaken existing RLS or grant broad cross-tenant reads as a shortcut.

## 9. Delivery and outbox

Create an outbox record in the same transaction as invitation creation. A worker/adapter sends the notification after commit. Delivery attempts, retries, and provider message IDs are operational metadata, not proof of acceptance. Never log the raw token or full token URL. Provider selection, credentials, templates, and retry policy require separate integration design.

## 10. Concurrency, idempotency, and state invariants

- Tenant row is the first lock for invitation create/revoke/accept and membership generation creation.
- Re-read actor, invitation, and membership state after acquiring locks.
- Use conditional updates with expected prior status/version.
- Use a unique correlation/idempotency key scoped to tenant and operation.
- Same correlation key with different actor, invitation, identity, or action is a conflict.
- A single invitation can produce at most one membership generation.
- One tenant/user can have at most one current active or suspended membership.
- Removed membership is terminal; re-entry creates a new membership ID and next generation.
- Expiration is checked with database time, not worker scheduling.
- No old-generation branch assignment can authorize a new membership. Future assignment foreign keys must target exact membership ID.

## 11. Required verification

Use real PostgreSQL 16, RLS ENABLE/FORCE, and the least-privilege application role. Add tests for:
1. Existing memberships remain unaffected by the new migration.
2. Only active owner/admin can create and revoke invitations.
3. manager/editor/viewer and inactive actors are denied.
4. owner role cannot be invited.
5. invitation expires after 72 hours according to database time.
6. pending -> accepted/revoked/expired transitions; terminal states cannot reopen.
7. expired invitation cannot be accepted even if no expiry worker ran.
8. token is single-use; token hash only is stored; raw token is absent from logs.
9. unverified or mismatched email/phone cannot accept.
10. client-supplied identity/tenant/role/verified flags cannot authorize acceptance.
11. existing active/suspended membership blocks invitation acceptance.
12. removed membership permits only a new generation through fresh invitation.
13. acceptance creates a new membership ID and increments generation exactly once.
14. concurrent acceptance requests create at most one membership.
15. concurrent invitation creation/replacement and lifecycle changes serialize safely.
16. invitation consumption, membership creation, and success audit are atomic; audit failure rolls back all.
17. same idempotency key retry is stable; mismatched reuse is rejected.
18. cross-tenant token/tenant/invitation probes fail closed and do not disclose existence.
19. RLS and tenant isolation hold for invitation and audit tables using the least-privilege role.
20. old-generation assignments cannot authorize a new generation once branch assignment runtime is implemented.
21. delivery retries do not create duplicate invitations or extend expiry unexpectedly.
22. outbox and provider logs never expose raw tokens.

## 12. Implementation prerequisites and open technical gates

Before implementation begins, the implementation plan must resolve:
- selected identity provider and trusted verified-identity assertion contract;
- safe token-to-tenant bootstrap lookup under RLS;
- email/phone normalization library and country context rules;
- token hash/pepper and secret rotation mechanism;
- invitation identity privacy/encryption and fingerprint key management;
- exact duplicate pending invitation/resend behavior;
- outbox schema/worker and delivery adapter boundary;
- whether denied unauthenticated attempts can be audited without unsafe cross-tenant disclosure;
- migration privileges, RLS policies, and trigger-level invariants.

These are engineering/security details to be finalized within the approved implementation scope. They must not be bypassed through permissive defaults.

## 13. Proposed implementation slices (not yet authorized)

1. **Persistence foundation:** invitation and audit schema, constraints, RLS, least-privilege grants, expiry/state invariants.
2. **Domain service:** invitation create/revoke/accept repositories, tenant-first locking, generation creation, idempotency, atomic audit.
3. **Identity proof boundary:** provider-neutral interface and test doubles; production adapter only after provider selection.
4. **Delivery boundary:** transactional outbox and provider-neutral delivery contract; no live provider until explicitly configured.
5. **Verification:** PostgreSQL 16 integration tests, race tests, security tests, typecheck, dependency audit, CI.

No HTTP API or UI should be included unless separately scoped and approved. Implementation must be reviewed against ADR-0010 and the security gates above.

## 14. Governance

This design is approved for documentation. Code implementation requires separate explicit founder approval of the bounded scope and prerequisites. Keep all work on `feat/adr-platform-foundation`; keep `main` unchanged. No merge, release, or deployment is authorized.
