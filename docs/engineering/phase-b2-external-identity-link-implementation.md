# Phase B2 — Secure External Identity Linking Implementation Record

**Status:** Implemented; CI verified  
**Branch:** `feat/adr-platform-foundation`  
**Pull request:** [#68 — Draft](https://github.com/hamidyaghobi70-beep/infinyx/pull/68)  
**Scope authorization:** B2 only. No unlink, recovery, merge, release, or deployment.

## 1. Delivered workflow

B2 adds two independent OIDC proofs before linking an external identity:

1. **Step-up reauthentication** through an identity already actively linked to the signed-in INFINYX user.
2. **Fresh authentication of the identity being added**, using a separate OIDC authorization transaction.

The BFF exposes:

- `POST /account/security/reauth`
- `GET /auth/reauth/callback`
- `POST /account/identities/link`
- `GET /auth/identity-link/callback`

The reauthentication challenge requests `prompt=login` and `max_age=0`. The new-identity challenge also requests `prompt=login`.

Both flows use Authorization Code + PKCE, state, nonce, exact configured issuer/client validation, a short-lived browser-binding cookie, and one-time purpose-bound transactions. The server derives the acting user and session from the active INFINYX server-side session. The new identity is derived only from validated OIDC `iss` and `sub` claims.

Step-up grants are single-use, expire after five minutes, and are bound to the initiating user and session. Consuming the grant and creating the link transaction occur in one database transaction.

## 2. Ownership and lifecycle safety

- The canonical identity remains the exact `(issuer, subject)` pair.
- Existing identity bindings are never updated, deleted, reassigned, or transferred.
- Existing Lifecycle records and Lifecycle event history are never updated or deleted by B2.
- A different-owner conflict returns a generic denial; the current owner is not disclosed.
- Suspended, revoked, or lifecycle-inconsistent identities are denied. B2 does not reactivate them.
- No email, phone, username, or profile matching is used.
- B2 does not create an INFINYX user or alter tenant membership, roles, branch assignments, or tenant selection.

A successful new binding is inserted into `user_external_identities`. The existing database trigger initializes Lifecycle only for that newly inserted identity. The identity binding, security audit event, and durable session-revocation outbox request commit atomically.

Same-user active bindings return an audited idempotent result without creating a duplicate or a second Lifecycle transition.

## 3. Additive database change

New migration: `migrations/010_external_identity_link_workflow.cjs`

It:

- Extends the allowed purpose set for identity-security transactions with `identity_link`.
- Adds an append-only `identity_security_audit_events` table.
- Adds `identity_session_revocation_outbox` with a unique pending request per user and guarded completion metadata.
- Does not rewrite or backfill existing identity bindings or Lifecycle records.
- Refuses rollback if audit, outbox, or identity-link transaction data would be destroyed.

The existing identity and Lifecycle tables are not altered by this migration.

## 4. Session containment and recovery from transient failure

After a new link commits, B2 revokes every web session for the user and clears the browser session cookie. The user must sign in again.

The durable outbox is written in the same transaction as the new binding and audit event. While an outbox request is pending:

- Existing sessions are rejected by session lookup, touch, and access-token refresh.
- New login resolution for that user is blocked.
- A failed revocation is returned as an indeterminate `503`, never as success.

The BFF retries pending revocations at startup and periodically while running. The outbox is marked complete only after session revocation is confirmed.

## 5. Verification

Successful GitHub Actions runs on the implementation branch:

- [CI run #45949586870](https://github.com/hamidyaghobi70-beep/infinyx/actions/runs/45949586870)
- [CI run #45949591075](https://github.com/hamidyaghobi70-beep/infinyx/actions/runs/45949591075)

Verified in the isolated CI environment:

- TypeScript typecheck passed.
- Web BFF production build passed.
- 25 test files passed; 158 tests passed.
- PostgreSQL integration tests covered:
  - Existing identity bindings and Lifecycle records remain field-for-field unchanged across B2 linking.
  - Concurrent attempts for the same external identity produce one owner only.
  - A required audit-write failure rolls back the new identity and its trigger-created Lifecycle records.
  - Failed session revocation remains pending; successful retry completes the outbox.
  - Step-up grant consumption and link-transaction creation are atomic and single-use.
- Migration syntax and migration application passed.
- Existing seeded legacy identity backfill verification passed.
- Ephemeral Keycloak discovery and JWKS verification passed.
- Dependency audit reported zero vulnerabilities.

The Keycloak CI check verifies discovery and JWKS connectivity; it is not an end-to-end browser login or live authorization-code callback test.

## 6. Operational requirements and limitations

- The deployed OIDC client must register both exact callback redirect URIs:
  - `https://<public-origin>/auth/reauth/callback`
  - `https://<public-origin>/auth/identity-link/callback`
- The existing `OIDC_REDIRECT_URI` remains the ordinary login callback at `/auth/callback`.
- No account-security UI was added; this phase adds the BFF workflow endpoints.
- No migration was executed against a persistent staging or production database.
- No live Keycloak realm was configured or deployed.

## 7. Governance

- All changes remain on `feat/adr-platform-foundation`.
- PR #68 remains Draft and unmerged.
- `main` remains unchanged.
- No staging/production deployment, release, or publication was performed.
- Unlink, recovery, and any Phase C work remain outside this authorization.
