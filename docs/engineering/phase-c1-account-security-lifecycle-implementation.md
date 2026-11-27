# C1 — Internal User Account Security Lifecycle Implementation

**Status:** Implemented on `feat/adr-platform-foundation`; CI verification pending.

## Scope delivered

- Added migration `012_user_account_security_lifecycle.cjs`.
- Added tenant-independent account security state for each internal INFINYX user:
  - `active`, `suspended`, and `disabled` statuses.
  - Versioned state and transition metadata.
  - Append-only account security event history.
- Existing users receive an `active` version-1 state and a `legacy_backfill` event.
- New users receive an `active` state and `account_created` event through a database trigger.
- State transitions are constrained to:
  - `active -> suspended | disabled`
  - `suspended -> active | disabled`
  - `disabled` is terminal.
- Database triggers reject state deletion, identity/creation-time mutation, invalid transitions, and event update/delete.
- Migration preflight verifies the expected users schema and refuses to adopt pre-existing account-security tables with an unknown schema.
- The migration locks the users table during backfill and verifies user/state/backfill-event counts before commit.
- CI grants the application role read access and only the specific state-update columns; event history is read-only to the application role.
- CI adds checks for legacy backfill, new-user initialization, valid transitions, disabled terminal behavior, append-only history, and database-level immutability.

## Preservation boundaries

This migration does not update or rewrite:

- `user_external_identities` bindings;
- `user_external_identity_lifecycle` or its event history;
- tenant memberships, roles, or branch assignments;
- existing web sessions or identity security transactions.

The down migration refuses to remove account security state or event history once records exist.

## Explicitly not included

C1 does not enforce account status during login or session use. That integration belongs to C2. It does not implement recovery (C3), final audit closure (C4), admin endpoints, Keycloak changes, merge, deployment, or release.

## Database verification boundary

The available CI database is an ephemeral PostgreSQL 16 database populated with synthetic test records. No production or staging database credentials or connection were available, so no live environment rows were inspected. The migration is additive and includes a strict schema preflight, table lock, transactional backfill, and count verification; deployment still requires a separately authorized environment-specific migration review.

## Verification

- Migration syntax check, PostgreSQL migration execution, and account-security SQL assertions are added to CI.
- CI result: pending.
