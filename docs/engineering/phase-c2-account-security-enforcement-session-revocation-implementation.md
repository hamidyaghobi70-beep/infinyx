# C2 — Account Security Enforcement and Session Revocation

**Status:** Implemented on `feat/adr-platform-foundation`; GitHub Actions CI verified.

## Scope delivered

- Added migration `013_account_session_revocation_outbox.cjs`.
- Added durable `user_account_session_revocation_outbox` records linked to append-only account-security events.
- Extended the account-security transition trigger so `active -> suspended` and `active/suspended -> disabled` transitions atomically:
  - append the account-security event;
  - enqueue a session-revocation request.
- A partial unique index allows only one pending account-revocation request per user. Repeated restrictive transitions do not create competing pending requests; an existing pending request remains the fail-closed barrier.
- Account status is enforced in OIDC login identity resolution. Only users with an explicit `active` account-security state and no pending account-revocation request can proceed.
- Web session creation, lookup, touch, and access-token retrieval/refresh now require:
  - an explicit `active` account-security state;
  - no pending account-session revocation;
  - no pending external-identity session revocation.
- Added `account-session-revocation.ts`:
  - revoke every persisted web session for the account;
  - mark the outbox request complete only after revocation succeeds;
  - record retry attempts and a bounded error code on failure;
  - leave failed requests pending so all session paths remain blocked;
  - retry pending requests in bounded batches.
- BFF startup retries pending account-session revocations, and the runtime exposes a retry function for an operational worker or controlled invocation.
- Application database privileges are limited to reading the outbox and updating only completion/attempt/error fields. The application cannot insert or rewrite outbox ownership or event references.

## Security and preservation boundaries

- Account suspension/disablement is tenant-independent and applies to all of the user's web sessions.
- A missing account-security state fails closed.
- The outbox event and account-security transition are committed in the same database transaction.
- Session revocation failure is never reported as success; the pending outbox record continues to deny session use.
- No external identity binding, external identity lifecycle row/history, tenant membership, role, or branch assignment is changed by C2.
- Existing identity-session-revocation behavior remains in place and is checked alongside the new account-level barrier.

## Tests and verification

- PostgreSQL migration 013 executes in the disposable CI database.
- CI verifies that a restrictive account transition creates a pending revocation request.
- Unit tests cover successful completion, failure remaining pending, retry behavior, session gates, and login denial for inactive accounts.
- Typecheck: passed.
- Web BFF build: passed.
- Migration syntax check: passed.
- Dependency audit: 0 vulnerabilities.
- Unit and PostgreSQL integration tests: 27 test files, 174 tests passed.
- Ephemeral Keycloak OIDC discovery/JWKS integration: 1 test passed.
- CI push run: https://github.com/hamidyaghobi70-beep/infinyx/actions/runs/45954889906
- CI pull-request run: https://github.com/hamidyaghobi70-beep/infinyx/actions/runs/45954897656

## Environment boundary and exclusions

CI used an ephemeral PostgreSQL 16 database with synthetic test records and a temporary Keycloak realm. No production or staging database was accessed, and no live environment migration was run.

C2 does not add account administration endpoints or an administrative authorization model. Account recovery and recovery-specific ownership proof remain C3. Final cross-phase security audit/closure remains C4. Keycloak configuration, merge, deployment, and release are not included.

## Source state

- Implementation commit: `2cc3c4c0e00a3eaa20aa5ec665a04d9d891b2f9b`
- Branch: `feat/adr-platform-foundation`
- PR #68 remains open and Draft; it is not merged.
- `main` remains at `b9c201963b64b1b419714ac893003b7598191de5`.
