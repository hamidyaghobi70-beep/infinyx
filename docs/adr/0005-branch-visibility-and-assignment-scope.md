# ADR-0005: Branch Visibility and Explicit Assignment Scope

- **Status:** Accepted
- **Decision date:** 2026-11-27
- **Decision owner:** INFINYX founder
- **Related policy:** [Founder-approved Branch Access Policy](../governance/branch-access-policy-draft.md)

## Context

INFINYX supports multiple branches within a tenant. Tenant membership alone is not sufficient to authorize access to every branch. Branch visibility must be predictable, revocable, tenant-scoped, and checked together with the protected data operation.

## Decision

Adopt the founder-approved hybrid visibility policy:

- `owner` and `admin` have visibility to all branches belonging to their tenant.
- `manager`, `editor`, and `viewer` have visibility only to branches explicitly assigned to their tenant membership.
- A newly created branch is not automatically added to existing members' branch assignments.
- Removing a branch assignment revokes that member's visibility to the branch.
- Suspending or removing tenant membership ends all branch access for that membership.
- A client-supplied branch identifier is only a selector and never establishes authorization.

The approved scope concerns **visibility only**. It does not define role-specific write capabilities or who may administer assignments. Those decisions remain open and must be approved before implementing the corresponding operations.

## Authorization requirements

1. Verify the authenticated principal.
2. Establish the tenant context.
3. Confirm active tenant membership.
4. Resolve the branch and verify it belongs to that tenant.
5. Apply the role and explicit-assignment rule.
6. Perform the protected operation in the same transaction and trusted data-access boundary.
7. Audit assignment changes and sensitive operations.

All steps fail closed when scope or membership is missing, ambiguous, stale, or revoked. Branch-level authorization must never weaken tenant isolation.

## Consequences

### Positive

- Least-privilege visibility for branch-level staff.
- Explicit and revocable access assignments.
- New branches do not silently broaden existing users' access.
- Tenant-wide oversight remains available to owners and admins.

### Trade-offs

- Assignment lifecycle and administration require additional domain modeling.
- User interfaces must communicate the active branch scope clearly.
- Queries and background jobs must carry and validate branch scope where applicable.

## Implementation and verification

No branch schema or branch-scoped authorization is implied by this ADR until implemented and tested. Acceptance requires real-PostgreSQL integration coverage for assigned and unassigned access, cross-tenant references, revocation, suspended membership, transaction-bound authorization, and pooled-connection context isolation.

The existing PostgreSQL custom setting `app.tenant_id` remains defense in depth; it is not cryptographically authenticated against arbitrary SQL executed under the same database role. Parameterized SQL, least privilege, and independent security review remain mandatory.

## Governance

This ADR is accepted on the feature branch only. It does not authorize merge, release, or deployment. Changes to the approved role visibility scopes require renewed founder approval.
