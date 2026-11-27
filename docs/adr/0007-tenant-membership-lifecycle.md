# ADR-0007: Tenant Membership Lifecycle

- **Status:** Accepted
- **Decision date:** 2026-11-27
- **Decision owner:** INFINYX founder
- **Related decisions:** ADR-0001 (multi-tenancy), ADR-0005 (branch visibility and assignment scope), ADR-0006 (branch assignment administration authorization)

## Context

Tenant membership is the root of authorization for tenant and branch resources. The current schema stores membership identity and role but has no lifecycle status. Branch assignments must never preserve access after a membership is suspended or removed.

The founder approved an explicit three-state membership lifecycle.

## Decision

Tenant membership will use the following target states:

- **`active`:** the membership is active. Access is evaluated using its current role and applicable branch assignments.
- **`suspended`:** the membership record is retained, but all tenant and branch access is denied until the membership is reactivated.
- **`removed`:** the membership has ended and all tenant and branch access is denied. Historical audit records must be retained according to the eventual retention policy.

## Authorization requirements

1. Every protected operation must verify the current database-backed membership state.
2. Only `active` membership may authorize access.
3. Missing, `suspended`, or `removed` membership must fail closed, even if branch-assignment rows remain.
4. Membership-state verification and the protected data operation must share the same transaction.
5. Client-provided status or role values are never authorization evidence.
6. Reactivating a suspended membership restores only access permitted by the current role and still-valid branch assignments; it does not automatically assign new branches.
7. A removed membership cannot regain access merely because a stale assignment row remains.

## Data retention and assignment behavior

- Suspension retains the membership record and must not erase audit history.
- Removal ends access but must not erase historical audit events.
- The implementation must decide whether branch assignments are retained as inert historical rows or deleted while independent audit events are preserved.
- Any retained assignment row for a suspended or removed member is non-authorizing.
- Audit retention, immutability, and assignment cleanup rules must be defined before implementation.

## Consequences

### Positive

- Suspension can be reversed without recreating the membership identity.
- Removal is explicit and distinguishable from temporary suspension.
- Stale branch assignments cannot keep a suspended or removed member authorized.
- Audit history can remain available for security review.

### Trade-offs

- Authorization queries and repositories must consistently require `active` state.
- Membership lifecycle transitions need audited, transaction-safe implementation.
- Assignment cleanup/retention and audit retention require coordinated design.

## Implementation and verification

This ADR records the target policy only. The existing `tenant_memberships` table and current membership helpers do not yet implement lifecycle status. No migration or runtime behavior is implied by this decision.

Required integration tests include active access, suspended denial, removed denial, stale assignment denial, suspended-to-active reactivation, no implicit assignment expansion after reactivation, and same-transaction membership verification with the protected operation.

## Governance

This ADR is accepted on the feature branch only. It does not authorize merge, release, or deployment. Changes to lifecycle states or their access semantics require renewed founder approval.
