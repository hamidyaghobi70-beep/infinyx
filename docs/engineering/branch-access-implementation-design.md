# Branch Access Implementation Design

**Status:** Proposed technical design — not authorized for implementation  
**Scope:** Branch data model, visibility resolution, transaction boundaries, and security verification  
**Related decisions:** ADR-0001 (multi-tenancy), ADR-0004 (PostgreSQL/RLS), ADR-0005 (branch visibility and assignment scope), ADR-0006 (assignment administration authorization), ADR-0007 (tenant membership lifecycle), ADR-0008 (membership lifecycle administration)

## 1. Purpose

Translate the founder-approved branch visibility policy into an implementation-ready design without silently deciding unresolved authorization or lifecycle rules.

This document is a proposal only. It does not add database migrations, application code, or a complete permission matrix.

## 2. Existing implementation facts

The current persistence layer has:

- `tenants(id, name, created_at)`.
- `tenant_memberships(tenant_id, user_id, role, created_at)`, with primary key `(tenant_id, user_id)`.
- Tenant membership roles: `owner`, `admin`, `manager`, `editor`, and `viewer`.
- Tenant-scoped RLS using transaction-local `app.tenant_id`.
- `getTenantMembership` and `requireTenantRole`, which resolve membership inside a supplied tenant transaction.

The current membership table has no active/suspended/removed status or membership lifecycle timestamps. A missing membership row is currently treated as no membership. The founder has approved a three-state membership lifecycle for the target design: `active`, `suspended`, and `removed`. This lifecycle is a design decision only; the current schema and code do not yet implement it.

## 3. Approved branch visibility policy

The following policy is already founder-approved in ADR-0005:

1. `owner` and `admin` can see every branch belonging to their tenant.
2. `manager`, `editor`, and `viewer` can see only branches explicitly assigned to them.
3. Creating a branch does not automatically assign it to existing members.
4. Removing a branch assignment revokes that member's branch visibility.
5. A removed or suspended tenant membership ends all branch access.
6. A branch ID supplied by a client is only a selector; it is never proof of authorization.
7. Visibility is separate from write permissions. Assignment administration is governed by ADR-0006: only `owner` and `admin` may grant or revoke branch assignments.

## 4. Proposed relational model

### 4.1 Branches

Proposed table: `branches`.

| Column | Proposed type | Notes |
|---|---|---|
| `tenant_id` | text, not null | Tenant ownership |
| `id` | text, not null | Branch identifier, unique within tenant |
| `name` | varchar(160), not null | Display name |
| `created_at` | timestamptz, not null | Defaults to `now()` |

Proposed constraints:

- Primary key: `(tenant_id, id)`.
- Foreign key: `tenant_id REFERENCES tenants(id)`.
- Check branch identifier length, consistent with existing identifier limits.
- Add an index suitable for listing branches by tenant.

The composite key makes branch identity tenant-scoped. The same branch ID may exist in different tenants without creating a cross-tenant relationship.

### 4.2 Explicit branch assignments

Proposed table: `tenant_membership_branch_assignments`.

| Column | Proposed type | Notes |
|---|---|---|
| `tenant_id` | text, not null | Tenant scope |
| `user_id` | text, not null | Assigned member |
| `branch_id` | text, not null | Assigned branch |
| `created_at` | timestamptz, not null | Assignment creation time |

Proposed constraints:

- Primary key: `(tenant_id, user_id, branch_id)`.
- Composite foreign key `(tenant_id, user_id)` to `tenant_memberships(tenant_id, user_id)`.
- Composite foreign key `(tenant_id, branch_id)` to `branches(tenant_id, id)`.
- Index assignments by `(tenant_id, branch_id)` for branch/member lookups.

These composite foreign keys enforce that both the member and branch belong to the same tenant. Duplicate assignments are prevented by the primary key.

### 4.3 Tenant-wide visibility is derived, not copied

Do not create assignment rows for owners/admins merely to represent their tenant-wide visibility. Resolve their scope from the verified membership role. This avoids stale per-branch grants when branches are created later or membership roles change.

For manager/editor/viewer, visibility comes only from explicit assignment rows.

## 5. Membership lifecycle and revocation

The approved policy requires suspended or removed membership to end branch access. The current schema models removal by the absence of a membership row; it does not model suspension.

The founder has approved a three-state membership lifecycle:

- **`active`:** membership is active; access is evaluated using the member's role and branch assignments.
- **`suspended`:** membership is retained but all tenant and branch access is denied until it is reactivated.
- **`removed`:** membership has ended and all tenant and branch access is denied. Historical audit records must remain available according to the eventual retention policy.

This is a target design decision, not an implemented schema or behavior. The current membership table has no status column, and the current authorization helper does not yet check lifecycle state.

Every protected operation must verify that the membership is currently `active` inside the same transaction as the protected operation. Missing, `suspended`, or `removed` membership must fail closed, regardless of any surviving branch-assignment row.

Do not physically erase audit history when a membership is removed. Assignment retention and audit-history behavior must be designed together. The implementation must decide whether assignments are retained as historical/inert records or deleted while preserving independent audit events; retained assignment rows must never authorize suspended or removed members.

## 6. Visibility resolution and transaction boundary

A proposed branch visibility resolver should accept the verified principal, tenant transaction, and requested branch ID, and return either an authorized branch context or a generic authorization failure.

Resolution order:

1. Require the authenticated principal and establish the tenant transaction.
2. Resolve the current database membership inside that transaction.
3. Reject missing or inactive membership.
4. If role is owner/admin, verify that the requested branch belongs to the current tenant.
5. If role is manager/editor/viewer, require an explicit assignment for the exact `(tenant_id, user_id, branch_id)`.
6. Only then perform the protected branch-scoped read or write, using the same transaction.

The branch ID from the request is a selector only. Never trust a client-supplied tenant ID, role, or assignment claim as authorization evidence.

Authorization and the operation it protects must share one transaction. Do not perform `requireTenantRole` or branch assignment checks in a separate transaction and then access protected data later.

## 7. RLS and application enforcement

Proposed RLS coverage for new tables:

- Enable and force RLS on `branches` and `tenant_membership_branch_assignments`.
- Scope rows to the transaction's tenant context, consistent with the existing tenant tables.
- Keep application-level membership and branch-assignment checks in the trusted data-access layer.

Important limitation: the current `app.tenant_id` custom GUC is transaction-local but not cryptographically authenticated. SQL running under the same database role can set it. Therefore current RLS is defense-in-depth against omitted tenant predicates and repository mistakes, not a defense against arbitrary SQL execution or successful SQL injection. Parameterized queries, trusted query text, least-privilege database roles, and independent security review remain mandatory. Evaluate a stronger authenticated tenant-context design before production.

Do not treat a branch-scoped GUC as an authorization guarantee unless its trust model is separately reviewed. Prefer explicit tenant and branch predicates plus verified membership/assignment checks in the DAL.

## 8. Assignment administration authorization

Founder-approved decision recorded in ADR-0006:

- Only `owner` and `admin` may create or revoke branch assignments.
- `manager`, `editor`, and `viewer` may not administer branch assignments.
- This permission is limited to assignments within the actor's own tenant and does not permit changing tenant roles, tenant ownership, or cross-tenant access.
- Every grant/revoke operation must verify the actor's current database membership and allowed role in the same transaction as the assignment mutation.
- Assignment changes must be audited with actor, target member, branch, action, timestamp, and outcome.

Do not infer any additional delegation or role-management capability from this decision.

Still unresolved: write permissions for editor and viewer. Visibility must not be interpreted as permission to create, update, delete, publish, or administer branch data.



## 8.1 Membership lifecycle administration authorization

Founder-approved policy recorded in ADR-0008:

- Only an active, database-verified `owner` or `admin` may suspend, reactivate, or remove a membership in the same tenant.
- The target membership must belong to the actor's tenant.
- The actor's current membership state and role must be checked in the database; client and JWT role claims are not authorization evidence.
- Authorization and the lifecycle mutation must occur in the same tenant transaction.
- `manager`, `editor`, and `viewer` cannot administer membership lifecycle.
- Lifecycle administration does not imply role changes, ownership transfer, or branch-assignment administration beyond ADR-0006.
- Each attempted operation must be audited with tenant, actor, target member, action, timestamp, and outcome.

The following safeguards remain unresolved and are implementation gates: self-suspension/removal, admin actions against owners, last-active-owner protection, owner-to-owner actions, removal reversibility, exact transition/idempotency rules, and audit retention/immutability/failure behavior. Do not infer permissive behavior; affected operations must fail closed until these decisions are approved.

This policy is not implemented by the current schema or runtime helpers. It does not authorize migrations, repositories, endpoints, or UI.

## 9. Audit requirements

Assignment creation and revocation should produce security audit events containing, at minimum:

- tenant identifier;
- affected member and branch identifiers;
- actor identifier;
- action (grant/revoke);
- timestamp;
- outcome.

Do not store secrets or raw authentication tokens in audit records. Define retention, immutability, and failure behavior for audit writes before implementing assignment administration. Audit failure handling must not silently convert a denied or failed authorization into success.

## 10. Required security and integration tests

Use real PostgreSQL integration tests with the least-privilege application role and RLS enabled. Include at least:

1. A tenant member with an explicit assignment can resolve that branch.
2. An unassigned manager/editor/viewer cannot resolve the branch.
3. Owner and admin can resolve any branch in their own tenant without assignment rows.
4. A branch belonging to another tenant cannot be resolved, even if its ID is supplied.
5. A branch created after a member's assignments does not become visible automatically.
6. Revoking an assignment immediately prevents subsequent branch access.
7. Missing, suspended, or removed membership denies access even if an assignment row exists.
8. Reactivating a suspended membership restores only the access permitted by its current role and still-valid branch assignments; it does not silently grant new branches.
9. A removed membership cannot regain access merely because a stale assignment row remains.
8. A user who belongs to another tenant cannot use that membership to access this tenant's branch.
11. A branch ID supplied by the client never bypasses membership or assignment checks.
12. Transaction-local tenant context does not leak across pooled connections.
13. Authorization and protected data access occur in the same transaction.
14. The application database role is not superuser and does not have `BYPASSRLS`.
15. RLS is enabled and forced on all new tenant-scoped tables.
16. Cross-tenant assignment rows are rejected by composite foreign keys.
17. Generic authorization failures do not reveal whether another tenant's branch or member exists.

## 11. Membership lifecycle administration implementation gates

In addition to the unresolved branch-specific items below, ADR-0008 requires explicit decisions for self-suspension/removal, admin actions against owners, last-active-owner protection, owner-to-owner actions, removal reversibility, transition/idempotency rules, and audit retention/immutability/failure behavior. These must be settled before implementing membership lifecycle administration. Do not infer default permissions for these edge cases.

## 12. Implementation gates

Do not implement the migration or runtime resolver until the following are settled:

- assignment retention behavior after membership suspension/removal, including the independent audit retention policy;
- editor/viewer write permissions, if any, for branch-scoped resources;
- exact branch identifier and naming constraints, if different from the proposed defaults.

Once these decisions are approved, implement in small, independently tested changes on `feat/adr-platform-foundation`. Keep `main` unchanged. No merge, release, or deployment is authorized by this design.

## 13. Current status

This document records a proposed technical design based on the current repository schema and founder-approved visibility and assignment-administration policies. It is not an implementation authorization and does not claim production readiness.
