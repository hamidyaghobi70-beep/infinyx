# Branch Access Policy — Founder-Approved Decision

- **Status:** APPROVED — visibility scope only; not a complete permission matrix.
- **Approved:** 2026-11-27
- **Scope:** Access to branches (locations) inside one tenant/business.
- **Implementation status:** This document records the approved policy. It does not claim that branch schema, assignments, or branch-scoped authorization have been implemented.

## Approved policy (Option C as presented to the founder)

Tenant isolation remains the outer security boundary. Branch access is an additional authorization boundary inside a tenant and never grants access to another tenant.

| Tenant role | Branch visibility |
|---|---|
| `owner` | All branches in the tenant |
| `admin` | All branches in the tenant |
| `manager` | Only explicitly assigned branches |
| `editor` | Only explicitly assigned branches |
| `viewer` | Only explicitly assigned branches |

The role alone does not grant a manager, editor, or viewer access to every branch. Their branch scope must be represented by explicit assignments.

### Assignment behavior

1. An owner/admin's visibility covers all branches belonging to that tenant.
2. A manager, editor, or viewer can see only branches explicitly assigned to that member.
3. Creating a new branch does not automatically grant it to existing managers, editors, or viewers.
4. Removing an assignment revokes access to that branch.
5. A user's branch access ends when their tenant membership is suspended or removed.
6. A branch ID supplied by a client is a selector, never proof of authorization.

## Security invariants

1. A branch belongs to exactly one tenant.
2. Active tenant membership is required before branch permissions are evaluated.
3. Branch authorization and the protected data operation are checked within the same transaction and trusted data-access boundary.
4. Missing, ambiguous, stale, or revoked scope fails closed.
5. Cross-tenant branch references are rejected by database constraints and authorization checks.
6. Background jobs and platform support access require explicit, narrow, auditable scopes.
7. Permission changes are auditable; no implicit privilege escalation is allowed.
8. Tenant isolation is never weakened by branch-level permissions.

## Not decided by this approval

This approval defines branch visibility only. It does not define which create/update/delete actions each role may perform, nor does it decide who may grant/revoke assignments. Those are separate authorization decisions and must be documented before implementing assignment-management operations.

## Required authorization evaluation order

1. Verify the authenticated principal.
2. Establish tenant context from that verified principal.
3. Confirm active tenant membership in the same transaction as the operation.
4. Resolve the requested branch and prove that it belongs to the active tenant.
5. Apply the approved role-based branch visibility rule above.
6. Perform the protected data operation under the same tenant and branch scope.
7. Record an audit event for permission changes and sensitive operations.

Any failed or indeterminate step denies the operation.

## Required tests before implementation is accepted

- Owner/admin can access a branch belonging to their tenant.
- Manager/editor/viewer can access an explicitly assigned branch.
- Manager/editor/viewer cannot access an unassigned branch.
- A newly created branch is not implicitly visible to previously assigned members.
- Removing an assignment stops access.
- A non-member cannot access any branch, even with a valid-looking branch ID.
- A branch belonging to another tenant is not disclosed or modified.
- Suspended/revoked tenant membership stops all branch access.
- Cross-tenant branch assignments are rejected.
- Permission checks cannot be separated from the transaction performing the protected operation.
- Pool reuse cannot leak tenant or branch context.
- Tests use real PostgreSQL and the least-privilege application role, not only mocked role comparisons.

## Relationship to existing decisions

- ADR-0002 remains authoritative for tenant isolation.
- ADR-0003 remains authoritative for PostgreSQL persistence.
- Existing tenant roles are `owner`, `admin`, `manager`, `editor`, and `viewer`.
- The current tenant-membership repository check establishes tenant membership only. It does not implement branch authorization.
- The current custom PostgreSQL setting `app.tenant_id` is defense in depth, not a cryptographically authenticated identity against arbitrary SQL under the same database role. Parameterized SQL, least privilege, and independent security review remain required.

## Change control

This approved visibility policy may be implemented on the feature branch with real-PostgreSQL integration tests. Any change to the approved role scopes requires renewed founder approval. The unresolved action-permission and assignment-management questions must be settled before those operations are implemented.

This decision does not authorize merge, release, or deployment.
