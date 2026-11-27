# Phase B3 — External Identity Unlink Implementation Record

**Status:** Implemented on the feature branch; CI verification pending.

## Scope delivered

- Purpose-specific OIDC reauthentication for unlinking, producing a one-time five-minute step-up grant bound to the active user and initiating session.
- CSRF-protected unlink endpoint with server-side ownership checks.
- A per-user transaction-scoped advisory lock serializes concurrent unlink operations.
- The last active external sign-in identity cannot be unlinked.
- Unlink changes only the selected lifecycle row from `active` to `revoked`; the canonical `(issuer, subject)` binding is retained unchanged.
- The lifecycle transition trigger appends its immutable event. A separate immutable security audit event and session-revocation outbox record are committed in the same transaction.
- Pending outbox state remains fail-closed; a failed session revocation is not reported as success.
- Migration 011 preflights existing audit event values and aborts before changing the constraint if an unexpected value exists. It changes no existing rows and refuses rollback if unlink audit history exists.

## Verification coverage

- Purpose, session binding, one-time grant consumption, and replay rejection.
- Ownership denial, last-method guard, concurrent unlink attempts, audit failure rollback.
- Preservation of canonical identity binding and all prior lifecycle history.
- Pending session-revocation behavior and retry.
- Existing link, lifecycle, tenant, OIDC, and BFF tests remain in the CI suite.

## Boundaries

No identity transfer, account merge, reactivation, recovery, Keycloak configuration, tenant membership/role/branch change, production deployment, merge, or release is included. PR #68 remains a draft and `main` is not modified.
