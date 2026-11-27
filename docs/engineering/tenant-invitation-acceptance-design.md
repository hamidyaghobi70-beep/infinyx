# Tenant Invitation and Acceptance — Implementation Design

**Status:** Implementation in progress under founder approval; production integrations remain gated  
**Decision:** ADR-0010  
**Decision owner:** INFINYX founder  
**Default invitation lifetime:** 72 hours  
**Scope:** Persistence, identity proof, invitation state transitions, acceptance, audit, and verification design

## 1. Purpose and implementation boundary

This document translates ADR-0010 into an implementation-ready design. It is not a claim that invitation functionality exists. The branch now contains invitation persistence, tenant-scoped audit, encrypted delivery outbox storage, token/identity cryptographic primitives, and domain services for create, revoke, and acceptance. The identity-directory and identity-verifier contracts are provider-neutral and have no production provider implementation. No delivery worker/provider, HTTP endpoint, or UI exists.

All future implementation must remain on `feat/adr-platform-foundation`. The founder has approved the bounded implementation scope. Keep `main` unchanged. No merge, release, or deployment is authorized.

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
- No production identity provider or trusted assertion implementation has been selected; acceptance fails closed without an injected verifier.
- Branch tables and branch assignments are not implemented.
- Current code is not production-ready and has not undergone independent security review.

## 3. Implemented data model

### 3.1 `tenant_invitations`

Implemented columns:

| Column | Type | Purpose |
|---|---|---|
| `invitation_id` | UUID PK | Invitation identity |
| `tenant_id` | text NOT NULL | Tenant boundary |
| `identity_type` | text/enum NOT NULL | `email` or `phone` |
| `identity_fingerprint` | bytea NOT NULL | HMAC-SHA-256 fingerprint; raw identity is not stored in the invitation row |
| `token_hash` | bytea NOT NULL | HMAC-SHA-256 of a 256-bit random token |
| `identity_key_version`, `token_key_version` | integer NOT NULL | Key version metadata |
| `role` | text NOT NULL | `admin`, `manager`, `editor`, or `viewer` |
| `status` | text NOT NULL | `pending`, `accepted`, `revoked`, `expired` |
| `invited_by` | text NOT NULL | Actor subject |
| `created_at` | timestamptz NOT NULL | Database creation time |
| `expires_at` | timestamptz NOT NULL | Creation time plus 72 hours |
| `accepted_by` | text NULL | Authenticated account subject |
| `accepted_at` | timestamptz NULL | Acceptance time |
| `revoked_by` | text NULL | Revoking actor |
| `revoked_at` | timestamptz NULL | Revocation time |
| `version` | bigint NOT NULL | Concurrency/version guard |

Implemented schema constraints:
- Foreign key to tenant with deletion restricted, consistent with retained membership/audit history.
- Check constraints for identity type, role allowlist (excluding `owner`), status allowlist, valid expiry, and state metadata consistency.
- Unique token hash.
- Index pending invitations by tenant and identity fingerprint for controlled lookup.
- RLS ENABLE and FORCE with tenant-scoped policy.
- Application role receives only the minimum required SELECT/INSERT and narrowly scoped UPDATE columns. No application UPDATE/DELETE of audit rows.
- Raw identity and token are absent from the invitation row. The encrypted outbox payload contains the normalized target and raw token under AES-256-GCM with tenant/invitation/version associated data. Key storage, rotation, and production secret provisioning remain deployment gates.

A pending-identity lookup is serialized by the tenant row lock. Expired pending invitations are transitioned to `expired` using PostgreSQL time and audited before duplicate detection. A live duplicate pending invitation is rejected; resend/replacement is not implemented.

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

Do not store raw invitation tokens, OTPs, passwords, full verification payloads, or unnecessary personal data. The table has RLS ENABLE/FORCE and tenant scope. The application role has SELECT/INSERT only and cannot UPDATE/DELETE audit rows. Define retention and privileged audit access separately.

### 3.3 `tenant_invitation_delivery_outbox`

Implemented columns:
- `outbox_id`, `tenant_id`, `invitation_id`
- `key_version`, `nonce`, `ciphertext`, `auth_tag`
- `status`, `attempts`, `next_attempt_at`, `created_at`, `sent_at`

The payload is encrypted with AES-256-GCM. Tenant/invitation/key-version values are authenticated as associated data. The outbox is tenant-scoped with RLS ENABLE/FORCE. The ordinary application role can insert/read and update only delivery-state columns; it cannot change the encrypted payload.

## 4. Identity verification contract

Acceptance must receive a trusted, server-validated identity assertion from the selected authentication/identity layer. The future adapter contract should provide:
- authenticated account subject;
- verified identity type;
- canonical verified identity value or protected stable identity reference;
- verification status and verification timestamp;
- issuer/audience or equivalent trust metadata where applicable.

The adapter must validate issuer, audience, signature/cryptographic integrity, expiry, and account binding according to the selected provider. Do not accept client-supplied `verified=true`, raw email/phone, or user ID as proof.

The invitation service compares the trusted verified identity with the invitation's target identity using the same canonicalization rules used at invitation creation. Email normalization and phone normalization must be deterministic and versioned; phone parsing must use an explicit country context rather than guessing. The provider and exact assertion schema remain implementation prerequisites. The acceptance service accepts only a server-injected `InvitationIdentityVerifier`; no default or client-provided verifier exists, so acceptance remains unavailable until a provider is selected and integrated.

If the invitee is new, registration and verification happen before acceptance. If the invitee already has an account, they authenticate and prove control of the invited identity. Account linking remains exclusively within the trusted identity provider workflow.

## 5. Token handling

1. Generate a high-entropy random token using a cryptographically secure random generator.
2. The raw token exists only transiently while its encrypted outbox payload is created; it is never returned in general API responses or written to logs.
3. Store only a one-way hash using a suitable password/token hashing construction. Since tokens are high entropy, use a cryptographic hash with a server-side pepper or keyed HMAC; store key version metadata for rotation.
4. Verify candidates using constant-time comparison.
5. Bind token hash to one invitation and tenant; use unique constraints to prevent reuse.
6. Redact token-bearing URLs and request fields from logs, traces, analytics, and error reporting.
7. Rate-limit token checks and acceptance attempts by relevant combinations of IP/device, invitation, and account while avoiding account enumeration.

The current implementation uses HMAC-SHA-256 with 32-byte key material for token hashes and identity fingerprints, and AES-256-GCM for outbox payloads. Key material is injected, never committed. Key rotation and secure secret-manager wiring remain open; the current acceptance path requires matching key versions.

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
11. Insert an AES-256-GCM encrypted outbox payload in the same transaction. A worker must dispatch only after commit; the worker is not yet implemented.

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

### 8.1 Tenant resolution and RLS design

The implementation adds `lookup_tenant_for_invitation_token(bytea)`, a SECURITY DEFINER function with a fixed `search_path` that accepts only a server-computed token hash and returns only the associated `tenant_id`. `withInvitationTenantTransaction` calls this function before setting transaction-local tenant context; the client cannot supply the tenant. The function does not expose invitation rows or identity data.

**Production gate:** because invitation tables use FORCE RLS, the function owner must be a dedicated, reviewed role that can perform this narrow lookup through RLS (for example, a role with carefully scoped `BYPASSRLS`). CI currently runs migrations as PostgreSQL superuser solely to test the mechanism; that is not an acceptable production ownership model. Do not grant the ordinary application role broad cross-tenant table access.

## 9. Delivery and outbox

The `tenant_invitation_delivery_outbox` table is implemented with tenant RLS and encrypted payload columns (`nonce`, `ciphertext`, `auth_tag`, `key_version`). Creation inserts an AES-256-GCM encrypted payload in the same transaction as the invitation and audit event. The worker/adapter, retry scheduler, dead-letter policy, provider credentials, templates, and delivery status updates are not implemented. Delivery attempts and provider message IDs are operational metadata, not proof of acceptance. Never log the raw token or full token URL.

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

Before production enablement, the following items must be resolved:
- selected identity provider and trusted verified-identity assertion contract;
- production ownership of `lookup_tenant_for_invitation_token(bytea)`: the current security-definer function uses a fixed search path and returns only `tenant_id`, but its owner must be a dedicated, reviewed role able to read through forced RLS (for example a narrowly scoped `BYPASSRLS` role); the CI migration owner is the PostgreSQL superuser and is not a production pattern;
- email normalization/versioning and phone E.164 parsing/country-context rules (the current implementation rejects non-E.164 phone values rather than guessing);
- production secret-manager integration and key rotation/key-version lookup; current code uses injected HMAC/AES keys and does not implement rotation;
- fingerprint-key privacy governance and rotation procedure;
- exact duplicate pending invitation/resend behavior;
- outbox worker, delivery adapter, retry/backoff, rate limits, and provider selection;
- whether denied unauthenticated attempts can be audited without unsafe cross-tenant disclosure;
- migration privileges, RLS policies, and trigger-level invariants.

These gates must be resolved before production enablement. Missing provider configuration, keys, or the privileged lookup role must fail closed; do not weaken RLS or use permissive defaults.

## 13. Implementation slices and current status

1. **Persistence foundation:** IMPLEMENTED in migration 003; migration and CI verification PASS.
2. **Domain service:** create/revoke/acceptance services IMPLEMENTED with tenant-first locking, generation creation, encrypted outbox insertion, atomic audit, and create/revoke correlation idempotency. Broader race and acceptance replay coverage still require completion.
3. **Identity proof boundary:** provider-neutral directory/verifier contracts IMPLEMENTED; production adapter BLOCKED on provider selection.
4. **Delivery boundary:** encrypted transactional outbox schema and encryption primitives IMPLEMENTED; worker/provider adapter NOT IMPLEMENTED.
5. **Verification:** CI PASS on code commit `b7222e40f1cf031ffa023e624ba440b3f997efae` (9 files, 93 tests; typecheck and dependency audit passed).

No HTTP API or UI should be included unless separately scoped and approved. Implementation must be reviewed against ADR-0010 and the security gates above.

## 14. Governance

The founder approved implementation of the bounded scope. Provider selection, production secrets, lookup-function ownership, and production enablement remain separate gates. Keep all work on `feat/adr-platform-foundation`; keep `main` unchanged. No merge, release, or deployment is authorized.
