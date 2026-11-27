# ADR-0002: Tenant Data Isolation and Database Access Boundary

- **Status:** Proposed; persistence implementation is not authorized by this ADR alone.
- **Date:** 2026-11-27
- **Scope:** Application data access for tenant-owned records.

## Context

INFINYX currently verifies JWT identity and derives a tenant identifier from the verified principal. That establishes an authenticated tenant context; it does not, by itself, isolate persisted records. Every database read and write must enforce the same tenant boundary, including background jobs and future administrative paths.

The repository does not yet contain a database driver, schema, migration framework, or an approved persistence-engine decision. Therefore this ADR records the security contract and a candidate design without introducing an unverified database dependency.

## Security invariants

1. The tenant identifier used for data access comes only from a verified authenticated principal or a separately authenticated system identity. Never trust a tenant ID supplied only by a request body, query parameter, or header.
2. Tenant-owned reads, updates, and deletes are scoped by the authenticated tenant.
3. Inserts derive or validate the tenant ID against the authenticated scope; callers cannot write into another tenant.
4. Missing, invalid, or ambiguous tenant context fails closed.
5. Relationships between tenant-owned records must not permit cross-tenant references. Where supported, use composite keys/foreign keys that include `tenant_id`.
6. Authorization is enforced at the data-access boundary, not only in HTTP middleware.
7. Background jobs and administrative operations use explicit, auditable system scopes; they do not silently bypass tenant isolation.
8. No credentials, access tokens, or tenant data are written to logs.

## Candidate persistence design

**Preferred candidate for evaluation: PostgreSQL with a shared schema, an explicit `tenant_id` on every tenant-owned table, and Row-Level Security (RLS) as defense in depth.**

If PostgreSQL is selected:
- Enable and, where appropriate, force RLS on tenant-owned tables.
- Define policies that compare each row's `tenant_id` with a transaction-local tenant context.
- Set that context from the verified principal inside each transaction; never from untrusted request input.
- Ensure the application role does not own protected tables and does not have a privilege that bypasses RLS.
- Use transaction-scoped context so pooled connections cannot retain a previous request's tenant.
- Keep explicit tenant predicates in repository queries as an additional, reviewable safeguard.
- Add tenant-aware unique constraints and composite foreign keys where relationships are tenant-local.

This is a candidate, not a final database selection. Before implementation, confirm PostgreSQL availability, deployment model, migration tooling, and operational requirements. If another database is chosen, equivalent isolation guarantees must be demonstrated rather than assumed.

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

1. Select and document the persistence engine and migration strategy.
2. Implement tenant context propagation at the transaction boundary.
3. Add tenant-aware schema constraints and database-enforced policies.
4. Add repository-level tenant scoping.
5. Run integration tests against the real database, including connection-pool reuse and negative cross-tenant cases.
6. Verify that the application database role cannot bypass the isolation policy.
7. Only then consider the persistence boundary ready for security review.

## Consequences and open decisions

- No database package or production data model is added by this ADR.
- PostgreSQL RLS is the preferred candidate, pending confirmation of the deployment and operational environment.
- The current JWT principal is necessary input to this design, but is not proof that tenant isolation has been implemented.
- Merge and release remain separate approval decisions.
