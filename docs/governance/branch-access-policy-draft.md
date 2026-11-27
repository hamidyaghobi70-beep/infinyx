# Branch Access Policy — Founder Decision Draft

- **Status:** DRAFT — NOT APPROVED; not an authorization contract.
- **Date:** 2026-11-27
- **Scope:** Proposed access model for branches (locations) inside a tenant/business.
- **Implementation status:** No branch schema, branch membership, or branch-scoped authorization is established by this document.

## Purpose

INFINYX is designed to support multiple branches under one business. Before introducing branch-owned records or branch-specific operations, the product must define who can see and act on data for each branch.

Tenant isolation remains the outer security boundary. Branch access is an additional authorization boundary inside a tenant; it must never grant access to another tenant.

## Non-negotiable security invariants

1. A branch always belongs to exactly one tenant.
2. A user must first have an active membership in the tenant before any branch permission is considered.
3. Branch authorization and the protected data operation must be checked within the same transaction and trusted data-access boundary.
4. Missing, ambiguous, or stale branch scope fails closed.
5. A branch ID supplied by a client is a selector, not proof of authorization.
6. Cross-tenant branch references must be rejected by database constraints and authorization checks.
7. Background jobs and platform support access require explicit, narrow, auditable scopes.
8. Branch access must be revocable and auditable; no implicit privilege escalation is allowed.

## Founder decision required: manager scope

Choose one policy before branch-level authorization is implemented.

### Option A — Tenant-wide manager

A manager can access all branches in their tenant by default. This is operationally simple for businesses whose managers oversee the whole organization, but it grants broad visibility.

### Option B — Assigned-branch manager

A manager can access only branches explicitly assigned to them. Access to each branch is represented by a separate assignment and can be revoked independently. This is more restrictive and supports regional or store-level management.

### Option C — Hybrid, explicit scope

Each manager is assigned either tenant-wide scope or one or more specific branches. The scope is explicit, visible to the owner/admin, and never inferred from the role name alone.

**Founder selection:** PENDING.

## Questions to resolve before implementation

- Which of Options A, B, or C is approved?
- Should owners and admins always have tenant-wide branch visibility, or can their access also be restricted?
- Should viewers/editors be assignable to one or more branches independently of their tenant role?
- Who may grant and revoke branch assignments?
- What should happen to a user's branch assignments when their tenant membership is suspended or removed? (Recommended invariant: all branch access ends immediately.)

## Proposed authorization evaluation order

This is a design proposal, not implemented behavior:

1. Verify the authenticated principal.
2. Establish the tenant context from that verified principal.
3. Confirm active tenant membership in the same transaction as the operation.
4. Resolve the requested branch and prove that it belongs to the active tenant.
5. Evaluate the approved tenant-role and branch-scope policy.
6. Perform the data operation under the same tenant and branch scope.
7. Record an audit event for permission changes and sensitive operations.

Any failed or indeterminate step denies the operation.

## Required tests before acceptance

- Tenant member accesses an authorized branch.
- Tenant member cannot access an unassigned branch under the selected policy.
- Non-member cannot access any branch, even with a valid-looking branch ID.
- Branch belonging to another tenant is not disclosed or modified.
- Suspended/revoked membership or branch assignment stops access.
- A branch assignment cannot be created across tenants.
- Permission checks cannot be separated from the transaction that performs the protected operation.
- Pool reuse cannot leak tenant or branch context.
- Tests use real PostgreSQL and the least-privilege application role, not only mocked role comparisons.

## Relationship to existing decisions

- ADR-0002 remains authoritative for tenant isolation.
- ADR-0003 remains authoritative for PostgreSQL persistence.
- Existing tenant roles are `owner`, `admin`, `manager`, `editor`, and `viewer`; this draft does not redefine their permissions.
- The current tenant-membership repository check establishes tenant membership only. It does not implement branch authorization.
- The current custom PostgreSQL setting `app.tenant_id` is defense in depth, not a cryptographically authenticated identity against arbitrary SQL under the same database role. Parameterized SQL, least privilege, and independent security review remain required.

## Approval and change control

No branch authorization code or schema should be implemented until the founder resolves the manager-scope decision and the related permission semantics. After approval, record the decision in an ADR, implement the smallest vertical slice, add real-PostgreSQL integration tests, and verify CI on this feature branch.

This draft does not authorize merge, release, or deployment.
