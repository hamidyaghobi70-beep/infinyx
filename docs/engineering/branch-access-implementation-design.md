# Branch Access Implementation Design

**Status:** Proposed technical design — not authorized for implementation  
**Scope:** Branch data model, visibility resolution, transaction boundaries, and security verification  
**Related decisions:** ADR-0001 (multi-tenancy), ADR-0004 (PostgreSQL/RLS), ADR-0005 (branch visibility and assignment scope)

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

The current membership table has no active/suspended status or membership lifecycle timestamps. A missing membership row is currently treated as no membership. Do not assume soft suspension is already supported.

## 3. Approved branch visibility policy

The following policy is already founder-approved in ADR-0005:

1. `owner` and `admin` can see every branch belonging to their tenant.
2. `manager`, `editor`, and `viewer` can see only branches explicitly assigned to them.
3. Creating a branch does not automatically assign it to existing members.
4. Removing a branch assignment revokes that member's branch visibility.
5. A removed or suspended tenant membership ends all branch access.
6. A branch ID supplied by a client is only a selector; it is never proof of authorization.
7. This policy defines visibility only. It does not grant write permissions or define who may create/revoke assignments.

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

Before implementation, decide whether membership lifecycle should use:

- **Hard removal:** delete the membership row; dependent assignment rows may be removed by a defined FK action, while audit history is stored separately.
- **Soft suspension:** add explicit membership status and lifecycle timestamps; every authorization query must require an active membership.

Do not rely solely on stale assignment rows to authorize access. Every protected operation must first establish current tenant membership in the same transaction. An inactive or missing membership must deny access regardless of any assignment record.

Assignment retention and audit-history behavior must be designed together. Avoid silently cascading away the only record of who granted or revoked access. If assignments are deleted, preserve the security audit event independently.

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

## 8. Assignment administration remains undecided

ADR-0005 does not decide who may grant or revoke branch assignments. This design intentionally does not infer that permission from branch visibility or from a role name.

Before implementing assignment-management endpoints or repository methods, obtain an explicit founder decision on the authorized grant/revoke actors and any delegation rules.

Also unresolved: write permissions for editor and viewer. Visibility must not be interpreted as permission to create, update, delete, publish, or administer branch data.

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
7. Missing or inactive membership denies access even if an assignment row exists.
8. A user who belongs to another tenant cannot use that membership to access this tenant's branch.
9. A branch ID supplied by the client never bypasses membership or assignment checks.
10. Transaction-local tenant context does not leak across pooled connections.
11. Authorization and protected data access occur in the same transaction.
12. The application database role is not superuser and does not have `BYPASSRLS`.
13. RLS is enabled and forced on all new tenant-scoped tables.
14. Cross-tenant assignment rows are rejected by composite foreign keys.
15. Generic authorization failures do not reveal whether another tenant's branch or member exists.

## 11. Implementation gates

Do not implement the migration or runtime resolver until the following are settled:

- membership removal versus suspension lifecycle and assignment/audit retention;
- who is allowed to grant and revoke branch assignments;
- editor/viewer write permissions, if any, for branch-scoped resources;
- exact branch identifier and naming constraints, if different from the proposed defaults.

Once these decisions are approved, implement in small, independently tested changes on `feat/adr-platform-foundation`. Keep `main` unchanged. No merge, release, or deployment is authorized by this design.

## 12. Current status

This document records a proposed technical design based on the current repository schema and approved visibility policy. It is not an implementation authorization and does not claim production readiness.
