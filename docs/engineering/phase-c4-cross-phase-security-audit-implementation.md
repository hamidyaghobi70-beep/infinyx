# C4 — Cross-Phase Account Security Audit and Verification

**Status:** Implemented and CI verified on `feat/adr-platform-foundation`.
**Purpose:** Close the account-security/recovery phase with cross-phase authorization, session, outbox, concurrency, preservation, and rollback checks.

## Audit findings and hardening

### 1. Outbox completion could be marked directly by the application role

**Finding:** Before C4, the application role had column-level UPDATE permission on `completed_at` for both `identity_session_revocation_outbox` and `user_account_session_revocation_outbox`. Application code was expected to revoke sessions before updating that column, but the database did not enforce the ordering.

**Fix:** Migration `015_database_owned_session_revocation_completion.cjs` adds two narrowly scoped `SECURITY DEFINER` functions:
- `complete_identity_session_revocation(outbox_id, user_id)`
- `complete_user_account_session_revocation(outbox_id, user_id)`

Each function locks the exact pending outbox row, revokes every still-active persisted web session for the matching user, and marks the outbox complete in the same database transaction. A mismatched user/outbox pair or an already completed/nonexistent row cannot complete another request.

The migration revokes the application's prior UPDATE privileges for outbox completion and grants only:
- SELECT/INSERT where required by the existing workflow;
- UPDATE of retry metadata (`attempts`, `last_error_code`);
- EXECUTE on the database-owned completion functions.

The migration's down path restores the prior column grants only when no outbox history exists; otherwise it refuses rollback.

### 2. Session operations did not independently verify the bound identity lifecycle

**Finding:** Account status and pending outboxes were checked, but the session store did not independently require the exact session `(user_id, issuer, subject)` binding to remain in active identity lifecycle state.

**Fix:** Session creation, lookup, touch, and access-token retrieval/refresh now require an exact matching row in `user_external_identities` joined to `user_external_identity_lifecycle` with `status = active`. Missing or revoked identity state fails closed, even if a pending revocation outbox is absent.

### 3. Cross-phase verification and rollback safety

Added/expanded tests to verify:
- the application role cannot directly update either outbox's `completed_at`;
- database-owned completion revokes persisted sessions before completion;
- failed revocation leaves the outbox pending and retryable;
- account and identity session barriers remain effective;
- an existing session is denied immediately when its linked identity becomes revoked, even without an outbox row;
- successful recovery revokes pre-existing sessions before fresh login;
- concurrent recovery attempts serialize to one successful transition;
- revoked identities and disabled accounts cannot be recovered;
- immutable external identity bindings and prior lifecycle history remain unchanged;
- account-security, recovery-audit, and outbox history are preserved;
- migrations 012–015 refuse destructive rollback while their state, audit, or outbox records exist.

## Migration 015

Migration `015_database_owned_session_revocation_completion.cjs`:
- adds the two database-owned completion functions with fixed search paths and qualified table references;
- revokes PUBLIC execution;
- conditionally removes prior direct completion-update privileges from `infinyx_app` and grants least privilege;
- refuses down migration while either identity or account revocation outbox contains records;
- restores the previous completion-column grants only on a safe empty-outbox rollback.

## Verification

Verified code commit: `b4ae30f11d388d93437a64c96d69914daf401aff`

- GitHub Actions push run: https://github.com/hamidyaghobi70-beep/infinyx/actions/runs/45958974264
- All migrations and migration syntax checks: passed.
- Least-privilege grants and direct-completion denial checks: passed.
- TypeScript typecheck: passed.
- Web BFF build: passed.
- Dependency audit: 0 vulnerabilities.
- Unit and PostgreSQL integration suite: **31 test files, 194 tests passed**.
- Ephemeral Keycloak discovery/JWKS integration: **1 test passed**.
- Rollback safety tests: migrations 012, 013, 014, and 015 all refused destructive rollback with retained data; tables remained present.

## Remaining rollout blockers and explicit exclusions

C4 closes the approved implementation and verification scope. It does not imply production readiness:

- The new OIDC recovery callback URI `/auth/account-recovery/callback` still needs explicit allow-list configuration in the real provider client.
- No production or staging database was accessed or migrated.
- No verified security-notification channel is wired into account recovery.
- A trusted-edge rate-limit policy for public recovery initiation is required before public exposure.
- An account with no remaining active linked identity has no automatic recovery path; email/phone matching, identity transfer, and support override remain prohibited.
- Account administration endpoints and their authorization model are not part of C4.
- No Keycloak configuration change, merge, deployment, release, or production publication was performed.

## Repository state

- Branch: `feat/adr-platform-foundation`
- PR #68 remains open and Draft.
- `main` remains unchanged.
