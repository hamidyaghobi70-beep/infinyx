# ADR-0003: PostgreSQL Persistence and Tenant Isolation

- **Status:** Accepted as the target architecture; operational validation is required before production use.
- **Date:** 2026-11-27
- **Scope:** Initial persistence platform for INFINYX's multi-tenant application.

## Decision

INFINYX will target **PostgreSQL with a shared database and shared tenant-aware tables** for the initial multi-tenant implementation.

The persistence boundary will use:
- A dedicated Data Access Layer (DAL) so application modules do not issue ad hoc database queries.
- An explicit `tenant_id` on every tenant-owned record.
- PostgreSQL Row-Level Security (RLS) as a database-enforced defense-in-depth boundary.
- Tenant-aware constraints and composite foreign keys for tenant-local relationships.
- Transaction-scoped tenant context derived only from a verified authenticated principal.
- Explicit tenant predicates in DAL operations, in addition to RLS.

Dedicated databases per tenant may be evaluated later for customers with justified isolation, residency, or operational requirements. They are not part of the initial implementation.

## Security requirements

1. The application database role must not own protected tables and must not have `BYPASSRLS`.
2. RLS must be enabled on all tenant-owned tables and forced where appropriate.
3. Tenant context must be set transaction-locally and cleared automatically at transaction end; pooled connections must never retain tenant context between requests.
4. Reads, inserts, updates, and deletes must be scoped to the authenticated tenant.
5. Client-supplied tenant identifiers are never authoritative.
6. Migrations and privileged maintenance use a separate, tightly controlled database role.
7. Cross-tenant references must be prevented by composite keys/foreign keys where applicable.
8. Sensitive data and credentials must not be logged.

## Implementation sequence

1. Add a PostgreSQL driver and migration tooling only after dependency installation is reproducible through a committed lockfile and CI uses `npm ci`.
2. Define the transaction API that accepts a verified principal and establishes transaction-local tenant context.
3. Implement the DAL and prohibit tenant-owned data access outside it.
4. Add initial schema and RLS policies using least-privilege roles.
5. Add integration tests against a real PostgreSQL service in CI.
6. Verify connection-pool reuse, missing tenant context, forged tenant IDs, cross-tenant reads/writes, and RLS bypass resistance.
7. Document migration, backup/restore, and operational procedures before production deployment.

## Acceptance criteria

- Tenant A can access its own records.
- Tenant A cannot read, modify, or delete Tenant B's records, including when it knows their identifiers.
- Tenant A cannot insert records under Tenant B.
- Missing or invalid tenant context fails closed.
- Pooled connection reuse does not leak context between tenants.
- Cross-tenant relationships are rejected.
- The application role cannot bypass RLS.
- Integration tests exercise the real PostgreSQL policies, not only mocked repositories.

## Consequences and constraints

- PostgreSQL is the selected target; the exact hosting provider and deployment topology remain open.
- The shared-table approach is operationally efficient but makes RLS, transaction scoping, and DAL enforcement critical security controls.
- No database package, schema, migration, or runtime code is introduced by this ADR itself.
- This decision does not mean tenant isolation is already implemented or production-ready.
- Merge and release remain separate approval decisions.
