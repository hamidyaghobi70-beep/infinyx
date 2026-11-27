# ADR-0002: Tenant Data Isolation and Database Access Boundary

- **Status:** Accepted as the tenant-isolation security contract; PostgreSQL target selection is recorded in ADR-0003.
- **Date:** 2026-11-27
- **Scope:** Application data access for tenant-owned records.

## Context

INFINYX verifies JWT identity and derives a tenant identifier from the verified principal. That establishes an authenticated tenant context; it does not, by itself, isolate persisted records. Every database read and write must enforce the same tenant boundary, including background jobs and future administrative paths.

ADR-0003 selects PostgreSQL with a shared database and shared tenant-aware tables as the target persistence architecture. This ADR defines the security contract that the persistence implementation must satisfy. The repository does not yet contain a database driver, schema, migration framework, or implemented database isolation boundary.

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

Tests must exercise the actual persistence adapter and database policies. A unit test that only compares two tenant ID strings is not evidence of database isolation.

## Rollout and acceptance

1. Ensure dependency installation is reproducible through a committed lockfile and CI uses `npm ci`, as required by ADR-0003.
2. Implement tenant context propagation at the transaction boundary.
3. Add tenant-aware schema constraints and database-enforced RLS policies.
4. Implement repository-level tenant scoping through the DAL.
5. Run integration tests against the real PostgreSQL database, including connection-pool reuse and negative cross-tenant cases.
6. Verify that the application database role cannot bypass the isolation policy.
7. Only then consider the persistence boundary ready for independent security review.

## Consequences and open decisions

- ADR-0003 is authoritative for the PostgreSQL platform decision; this ADR is authoritative for tenant-isolation invariants and acceptance tests.
- The current JWT principal is necessary input to this design, but is not proof that tenant isolation has been implemented.
- PostgreSQL hosting provider and deployment topology remain open.
- Merge and release remain separate approval decisions.
