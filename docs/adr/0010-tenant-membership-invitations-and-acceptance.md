# ADR-0010: Tenant Membership Invitations and Acceptance

- **Status:** Accepted — design approved; implementation not yet authorized
- **Decision date:** 2026-11-27
- **Decision owner:** INFINYX founder
- **Related decisions:** ADR-0001, ADR-0003, ADR-0005, ADR-0006, ADR-0007, ADR-0008, ADR-0009

## 1. Context

The platform implements tenant membership generations and a terminal `removed` state. A removed membership must not be reactivated. Re-entry must occur through a fresh invitation and create a new membership generation. Invitation acceptance must not restore branch assignments or other authorization inherited from a prior generation.

The repository does not yet implement invitation storage, delivery, acceptance, identity verification integration, HTTP endpoints, or UI. This ADR records the founder-approved product and security decisions for a future implementation. It does not authorize code implementation, merge, release, or deployment.

## 2. Accepted decisions

### 2.1 Invitation authority

1. Only a current, database-verified, active `owner` or `admin` of the same tenant may create or revoke invitations.
2. Authorization must be checked in the same tenant-scoped transaction as the invitation mutation.
3. The actor role and status must come from current database state, never client input or JWT role claims.
4. `manager`, `editor`, and `viewer` cannot create or revoke invitations.
5. Invitations may grant only `admin`, `manager`, `editor`, or `viewer`.
6. Invitation to `owner` is prohibited. Ownership transfer and owner departure require a separate ownership-governance workflow.
7. Revocation is restricted to active, database-verified `owner` or `admin` actors in the same tenant.

### 2.2 Invitation identity and proof

1. An invitation targets exactly one normalized email address or one normalized phone number.
2. The invited identity is not proof of account ownership.
3. Acceptance requires an authenticated account and a trusted identity-verification result proving control of the exact invited email address or phone number.
4. The verification must be bound to the authenticated account by the identity/authentication layer. A caller-supplied email, phone, user ID, or verification flag is never sufficient.
5. If the invited person has no account, account registration and verification must complete before acceptance. Existing accounts must authenticate and prove control of the invited identity.
6. Linking an email/phone identity to an account must follow the identity provider's secure account-linking process; invitation acceptance must not create an alternate account-linking bypass.
7. If the current identity provider cannot provide a trustworthy verified-identity assertion, acceptance remains unavailable until that integration is designed and approved.

### 2.3 Invitation lifetime and state

1. Default invitation lifetime is **72 hours** from database creation time.
2. Invitation states are `pending`, `accepted`, `revoked`, and `expired`.
3. Only `pending` may transition to `accepted`, `revoked`, or `expired`.
4. Expired invitations cannot be accepted or revived. A new invitation must be created.
5. Accepted and revoked invitations are terminal. Repeated same-operation requests must be safe and must not create duplicate membership generations or duplicate transition events.
6. Expiration is enforced using database time during acceptance/revocation and may also be materialized by a maintenance process. Correctness must not depend on a background expiry job running on time.

### 2.4 Membership eligibility and generation

1. An invitation may be accepted only if the target account has no current `active` or `suspended` membership in the tenant.
2. A suspended membership must first be handled through the approved membership lifecycle administration process; a new invitation cannot bypass suspension.
3. If the latest membership generation is `removed`, a fresh invitation may create the next generation.
4. Acceptance creates a new `membership_id`, increments `generation`, and uses the role stored in the invitation. The client cannot choose or change the role during acceptance.
5. The invitation acceptance and membership creation are one atomic tenant-scoped database transaction.
6. Tenant-row locking, revalidation after lock acquisition, uniqueness constraints, and idempotency must prevent concurrent acceptances from creating duplicate current memberships or generations.
7. A successful invitation can be consumed only once. Replays return a stable result or a generic already-consumed response without creating another membership.

### 2.5 Branch assignments and authorization isolation

1. Branch assignments must reference the exact `membership_id` generation, not only a user ID.
2. A newly accepted membership receives no branch assignments from an earlier generation.
3. Historical assignments may remain attached to the old generation as inert history; they must never authorize the new generation.
4. The new member's branch visibility follows ADR-0005 and future branch-assignment administration implementation. No branch is implicitly assigned during invitation acceptance.
5. Membership verification and every protected operation remain in the same tenant transaction.

### 2.6 Token and abuse protection

1. Invitation tokens must be generated using a cryptographically secure random source with sufficient entropy.
2. Store only a one-way token hash; never persist or log the raw token.
3. Tokens are single-use and bound to one invitation record and tenant.
4. Compare token hashes using an appropriate constant-time verification approach.
5. Apply rate limits and abuse monitoring to invitation creation, delivery requests, token verification, and failed acceptance attempts.
6. Do not reveal whether an email, phone, account, tenant membership, or invitation exists through unauthenticated responses.
7. Secrets, OTPs, raw invitation tokens, and unnecessary personal data must not appear in audit events, application logs, or error messages.

### 2.7 Audit and atomicity

1. Invitation creation, revocation, successful acceptance, expiry resolution, and relevant denied attempts must be auditable.
2. Audit records should include tenant, actor (when authenticated), invitation identifier, target identity reference in minimized/appropriately protected form, requested action, prior/new state, timestamp, outcome, and correlation identifier.
3. Successful acceptance, membership creation, invitation consumption, and the required success audit record must commit atomically. Any required audit write failure rolls back the acceptance and membership creation.
4. Denied attempts should be recorded where safely possible without exposing sensitive identity details. Failure to persist a required success audit must never be treated as success.
5. Audit data must be tenant-scoped, append-only for the application role, and governed by a separately defined retention and privileged-reader policy.

### 2.8 Delivery boundary

1. Invitation delivery is performed through a future adapter (email or SMS) with scoped credentials, retries, rate limits, and delivery outcome logging.
2. Delivery is not proof of identity and does not itself accept an invitation.
3. The design does not assume that any specific email/SMS provider or production credential is available.
4. Raw invitation tokens must not be included in provider logs or general observability events. The delivery path must be designed so that the token is disclosed only to the intended recipient through the approved channel.

## 3. Invitation transition table

| Current state | Requested event | Result |
|---|---|---|
| pending, before expiry | verified acceptance | accepted, with membership creation atomically |
| pending, before expiry | authorized revocation | revoked |
| pending, at/after expiry | acceptance attempt | expired; acceptance denied |
| pending, at/after expiry | expiry resolution | expired |
| accepted | any replay or revocation | terminal; no second membership |
| revoked | acceptance or replay | terminal; deny |
| expired | acceptance or replay | terminal; deny |

No transition from `accepted`, `revoked`, or `expired` back to `pending` is allowed. A new invitation creates a new invitation record.

## 4. Explicit non-goals

This ADR does not implement or authorize:
- HTTP routes/controllers, UI, or user-facing invitation screens;
- email/SMS provider selection, credentials, or live delivery;
- authentication-provider selection or identity-provider configuration;
- ownership transfer, owner invitations, or self-leave;
- branch tables, assignment runtime, or branch permission changes;
- tenant deletion, audit retention duration, or privileged audit-reader access;
- merge, release, or deployment.

## 5. Governance

This ADR is accepted as a product/security design decision on `feat/adr-platform-foundation`. Implementation requires a separate explicit founder approval of a bounded implementation plan. Keep `main` unchanged. No merge, release, or deployment is authorized.
