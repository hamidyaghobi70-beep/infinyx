# ADR-0002: Tenant Data Isolation and Database Access Boundary

- **Status:** Accepted as the tenant-isolation security contract; PostgreSQL target selection is recorded in ADR-0003.
- **Date:** 2026-11-27
- **Scope:** Application data access for tenant-owned records.

## Context

INFINYX verifies JWT identity and derives a tenant identifier from the verified principal. That establishes an authenticated tenant context; it does not, by itself, isolate persisted records. Every database read and write must enforce the same tenant boundary, including background jobs and future administrative paths.

ADR-0003 selects PostgreSQL with a shared database and shared tenant-aware tables as the target persistence architecture. This ADR defines the security contract for the persistence implementation. The repository now contains an initial PostgreSQL pool adapter, a migration for the `tenants` and `tenant_memberships` tables, forced RLS policies, and real-PostgreSQL CI tests using a least-privilege application role. This is a verified foundation for these two tables, not yet a complete application DAL or domain schema.

## Security invariants

1. The tenant identifier used for data access comes only from a verified authenticated principal or a separately authenticated system identity. Never trust a tenant ID supplied only by a request body, query parameter, or header.
2. Tenant-owned reads, updates, and deletes are scoped by the authenticated tenant.
3. Inserts derive or validate the tenant ID against the authenticated scope; callers cannot write into another tenant.
4. Missing, invalid, or ambiguous tenant context fails closed.
5. Relationships between tenant-owned records must not permit cross-tenant references. Use composite keys/foreign keys that include `tenant_id` where applicable.
6. Authorization is enforced at the data-access boundary, not only in HTTP middleware.
7. Background jobs and administrative operations use explicit, auditable system scopes; they do not silently bypass tenant isolation.
8. No credentials, access tokens, or tenant data are written to logs.

## Required PostgreSQL enforcement

The implementation must follow ADR-0003 and:
- Use PostgreSQL Row-Level Security (RLS) on tenant-owned tables, forced where appropriate.
- Define policies that compare each row's `tenant_id` with a transaction-local tenant context.
- Set that context from the verified principal inside each transaction; never from untrusted request input.
- Ensure the application role does not own protected tables and does not have a privilege that bypasses RLS.
- Use transaction-scoped context so pooled connections cannot retain a previous request's tenant.
- Keep explicit tenant predicates in DAL operations as an additional, reviewable safeguard.
- Add tenant-aware unique constraints and composite foreign keys where relationships are tenant-local.

## Important security boundary limitation

The initial policy context uses the transaction-local PostgreSQL setting `app.tenant_id`. A custom setting is not a cryptographically authenticated identity: code running arbitrary SQL as the same application database role could attempt to change it. Therefore, this RLS design is defense in depth against omitted tenant predicates and ordinary repository mistakes; it must not be described as protection against arbitrary SQL execution or a successful SQL injection under the shared role. Parameterized SQL, trusted application-owned query text, least-privilege grants, and independent security review remain mandatory. A stronger database-authenticated tenant context must be evaluated before production use.

## Required isolation tests

Use two independently authenticated principals, Tenant A and Tenant B, and seed distinct records for each.

| Scenario | Required result |
|---|---|
| Tenant A reads its own record | Allowed |
| Tenant A attempts to read Tenant B's record by ID | Not found or denied; no data disclosed |
| Tenant A attempts to update or delete Tenant B's record | No change to Tenant B's data |
| Tenant A attempts to insert with Tenant B's tenant ID | Rejected |
| Request has no verified tenant context | Denied by default |
| Request supplies a forged tenant header/body field | Ignored for authorization; verified principal remains authoritative |
| A pooled connection is reused after Tenant A's transaction | Tenant B cannot observe Tenant A's context or records |
| Cross-tenant relationship is attempted | Rejected by database constraint or data-access policy |
| Background/system task accesses tenant data | Requires an explicit scoped identity and is audited |

Tests must exercise the actual persistence adapter and database policies. A unit test that only compares two tenant ID strings is not evidence of database isolation. The initial CI suite currently exercises the `tenants` and `tenant_memberships` tables against ephemeral PostgreSQL; every future tenant-owned table must be added to the same coverage before it is treated as isolated.

## Rollout and acceptance

1. Reproducible dependency installation through a committed lockfile and CI `npm ci`: COMPLETE.
2. Tenant context propagation at the transaction boundary: IMPLEMENTED and unit-tested.
3. Initial `tenants` and `tenant_memberships` schema constraints and forced RLS policies: IMPLEMENTED.
4. Real PostgreSQL integration tests for own-tenant access, cross-tenant read/write denial, missing context, and pool reuse: PASSING in CI.
5. Least-privilege application role without table ownership or `BYPASSRLS`: VERIFIED in CI.
6. Repository-level DAL, all future domain tables, broader relationship constraints, and stronger protection against arbitrary SQL execution: NOT YET IMPLEMENTED.
7. Independent security review is still required before production use.

## Consequences and open decisions

- ADR-0003 is authoritative for the PostgreSQL platform decision; this ADR is authoritative for tenant-isolation invariants and acceptance tests.
- The current JWT principal is necessary input to this design, but is not proof by itself. The initial RLS behavior has been verified only for the two tables named above and only within the stated threat-model limits.
- PostgreSQL hosting provider and deployment topology remain open.
- Merge and release remain separate approval decisions.
