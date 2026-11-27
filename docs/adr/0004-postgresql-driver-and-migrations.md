# ADR-0004: PostgreSQL Driver, Migrations, and Tenant Transaction Boundary

- **Status:** Accepted for the initial persistence implementation.
- **Date:** 2026-11-27
- **Scope:** PostgreSQL connectivity, schema migrations, and transaction-scoped tenant context.

## Context

ADR-0003 selects PostgreSQL with shared tenant-aware tables and Row-Level Security (RLS). The repository currently has no database driver, migration tooling, schema, connection pool, or persistence runtime. The implementation must preserve transparent SQL behavior so RLS policies, transaction boundaries, and tenant predicates remain reviewable.

## Decisions

1. Use the `pg` Node.js driver (`Pool` and `PoolClient`) as the PostgreSQL connectivity layer.
2. Use `node-pg-migrate` for versioned, reviewable schema migrations. Migrations are executed with a dedicated migration credential, never the ordinary application role.
3. Keep SQL explicit and parameterized. Do not introduce an ORM in the initial persistence layer; this avoids obscuring transaction and RLS behavior.
4. Centralize connection acquisition and transaction lifecycle in a persistence module. Feature modules must use repositories/DAL interfaces rather than creating pools or opening ad hoc connections.
5. Tenant-owned work must run inside a transaction created from an in-process verified `AuthenticatedPrincipal`. At transaction start, set the tenant context transaction-locally using a parameterized `set_config('app.tenant_id', $1, true)` call. The `true` argument makes the setting local to the transaction.
6. Commit only after the callback completes successfully. On any callback or commit failure, attempt rollback and always release the client. Never return a client with an open transaction to the pool.
7. Do not expose a tenant-switching API to request handlers. A transaction's tenant is immutable for its lifetime.
8. Keep the application database role separate from the migration role. The application role must not own tenant tables and must not have `BYPASSRLS`.
9. Connection strings and credentials come only from runtime secret configuration. They must never be committed, logged, or included in test output.

## Transaction contract

The initial public boundary should be equivalent to:

- Input: a verified `AuthenticatedPrincipal` and a callback receiving a restricted tenant transaction interface.
- Begin: acquire one pooled client and execute `BEGIN`.
- Scope: set the tenant context from `principal.tenantId`, never from request data.
- Execute: expose parameterized query operations through the transaction interface.
- Finish: commit on success; rollback on failure; release in all cases.

The transaction interface must not provide methods to change tenant context, disable RLS, or access the pool directly. System and migration scopes are separate future interfaces and must not be implemented as an undocumented bypass.

## Security and reliability requirements

- Missing or invalid principal fails before acquiring a database client.
- Tenant context is transaction-local and cannot leak through pooled connection reuse.
- All SQL values are parameterized; identifiers are selected only from trusted code.
- Transaction errors do not expose SQL, credentials, or raw database messages to API clients.
- Pool size, connection timeout, idle timeout, and statement timeout are explicit configuration with safe bounds.
- Shutdown drains the pool and closes outstanding connections.
- Migrations are serialized and run separately from application startup unless an explicitly reviewed deployment procedure says otherwise.

## Test strategy

Unit tests may validate transaction ordering, rollback, release, and rejection of unverified principals using a controlled fake client. These tests do not prove RLS isolation.

Acceptance requires integration tests against real PostgreSQL with the actual application database role and RLS enabled. At minimum, test:
- Tenant A can access its own rows.
- Tenant A cannot read, update, delete, or insert rows for Tenant B.
- Missing tenant context fails closed.
- A client reused by the pool for Tenant B cannot observe Tenant A's transaction context.
- The application role cannot bypass RLS or access protected tables outside the intended grants.
- Cross-tenant references are rejected by constraints.

## Consequences

- Explicit SQL and a small DAL are preferred over ORM convenience in the initial security-critical persistence layer.
- PostgreSQL connectivity can be tested independently from API routes.
- This ADR selects implementation tooling; it does not claim that PostgreSQL, RLS, migrations, or tenant isolation are already implemented.
- Hosting, production credentials, backup/restore, and deployment topology remain separate operational decisions.