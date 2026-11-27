# C3 — Safe Suspended Account Recovery Implementation

**Status:** Implemented on `feat/adr-platform-foundation`; GitHub Actions CI verified.
**Scope:** Self-service recovery of a suspended internal account using a fresh OIDC authentication from an already-bound, active external identity.

## Delivered workflow

1. `POST /account/recovery/start` accepts only the configured exact Origin and a bodyless request.
2. The BFF creates a five-minute, single-use recovery transaction:
   - cryptographically random OIDC state, nonce, and PKCE verifier;
   - SHA-256 hashes for state and browser binding;
   - AES-256-GCM encrypted verifier/nonce payload using a recovery-specific authenticated-encryption context;
   - a dedicated Secure, HttpOnly, SameSite=Lax, host-only recovery cookie.
3. The user authenticates with the configured OIDC provider using `prompt=login` and `max_age=0`.
4. The callback validates the exact callback path/origin, one-time state, browser binding, issuer, OIDC signature/audience/nonce/PKCE through the existing OIDC client, and a recent `auth_time` (maximum five minutes, with a small future clock-skew allowance).
5. The server derives the candidate identity exclusively from the validated `(iss, sub)` claims. It does not accept a user ID, tenant ID, email, phone, username, or identity ID from the browser.
6. In one database transaction, the recovery workflow:
   - resolves the exact immutable identity binding;
   - shares the per-user advisory lock with identity unlink;
   - locks and checks the identity lifecycle and account-security projection;
   - allows only `account.status = suspended` and `identity.lifecycle = active`;
   - changes only the account-security projection from suspended to active;
   - appends the account-security event and recovery audit event;
   - obtains the pending account-session revocation outbox record.
7. The BFF revokes all persisted web sessions before allowing a fresh login. If revocation fails, the outbox remains pending and session creation, session lookup, token use, and ordinary login remain fail-closed. A retry worker runs every 30 seconds.
8. On success, the browser is redirected to the normal login entry point; recovery does not create a session or expose provider tokens.

## Non-negotiable safeguards

- Only an already-bound exact `(issuer, subject)` identity in active lifecycle state can prove ownership.
- Revoked identities are never reactivated or reassigned.
- Disabled accounts are terminal and cannot be recovered.
- Active accounts, unknown identities, missing lifecycle state, and all other ineligible cases receive the same generic denial.
- No email/phone/profile matching, account merge, identity transfer, manual support override, or user-supplied account selection.
- No identity binding, external identity lifecycle row/history, tenant membership, role, branch assignment, or tenant state is changed.
- Recovery audit history is append-only. A successful account transition, account-security event, recovery audit event, and revocation outbox request commit atomically.
- Session revocation must complete before the normal login path can issue a new session.

## Database changes

Migration `014_account_recovery_workflow.cjs` adds:
- one-time, browser-bound, encrypted account recovery transactions;
- append-only recovery audit events;
- an account-security transition trigger update that creates a session-revocation outbox barrier for every status transition, including suspended-to-active recovery.

The migration is additive. It does not rewrite existing external identity bindings or lifecycle history. The down migration refuses to remove recovery transaction or audit records.

## Verification

Latest verified implementation commit: `5fcb63bd84508580ae56c192ab3aa8dbe579f70f`

- GitHub Actions push run: https://github.com/hamidyaghobi70-beep/infinyx/actions/runs/45958207587
- Migration syntax and all migrations: passed.
- Least-privilege application role and recovery transaction grants: exercised by PostgreSQL integration tests.
- PostgreSQL tests cover successful recovery, exact identity binding and lifecycle-history preservation, revoked identity denial, disabled-account denial, unbound identity denial, concurrent recovery serialization, audit append-only behavior, and session-revocation completion.
- Recovery transaction tests cover hashing, encryption, browser binding, expiry, and one-time consumption.
- BFF tests cover exact Origin, PKCE initiation, fresh authentication time, generic denial, and fail-closed behavior while revocation is pending.
- Typecheck: passed.
- Web BFF build: passed.
- Dependency audit: 0 vulnerabilities.
- Unit and PostgreSQL integration suite: **30 test files, 192 tests passed**.
- Ephemeral Keycloak discovery/JWKS integration: **1 test passed**.

## Explicit limitations before staging or production use

- No Keycloak client configuration was changed. The new callback URI `/auth/account-recovery/callback` must be explicitly allow-listed in the provider client before this flow can be used in a real environment.
- No production or staging database was accessed or migrated.
- No verified user-notification channel is currently wired into this recovery workflow. Security notification policy and implementation must be completed before public rollout.
- A lost-account case with no remaining active linked identity is intentionally not recoverable through this MVP flow. Email/phone matching and support-led reassignment remain prohibited.
- A production-grade rate-limit policy for the public recovery initiation endpoint must be configured at the trusted edge before public exposure; no untrusted forwarded-IP header is treated as authoritative here.
- No merge, deployment, release, or Keycloak configuration change was performed.

## Repository state

- Branch: `feat/adr-platform-foundation`
- PR #68 remains open and Draft.
- `main` remains unchanged.
