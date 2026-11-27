# Phase B — External Identity Link and Unlink Workflows: Detailed Security Design

**Status:** Proposed — design only; implementation requires separate explicit approval  
**Repository:** `hamidyaghobi70-beep/infinyx`  
**Branch:** `feat/adr-platform-foundation`  
**Depends on:** Phase A external identity lifecycle foundation; provider-neutral OIDC verifier; Web BFF and server-side sessions  
**Out of scope:** Phase C recovery, deployment, merge, release, and production/staging rollout

## 1. Purpose and design boundary

Phase B turns the Phase A lifecycle foundation into user-initiated, authenticated link and unlink workflows. It does not change the identity model: the canonical external identity remains the exact validated pair `(issuer, subject)`, and its original `user_id` binding is immutable.

The browser never supplies an authoritative user ID, issuer, subject, tenant ID, role, or branch scope. The server derives the acting user from the active INFINYX session. The new identity is derived only from a successfully validated OIDC authorization response, never from browser-submitted profile fields.

This document is a proposal, not implementation authorization. All time windows, endpoint names, schema additions, and behavior below are proposed defaults requiring review before code changes.

## 2. Current baseline and gaps

The reviewed branch currently has:

- OIDC authorization-code login with state, nonce, PKCE, a short-lived browser-binding cookie, and a one-time login transaction store.
- Server-side encrypted provider token bundles; browser cookies carry opaque session identifiers.
- CSRF validation for state-changing requests using exact Origin and an `x-infinyx-csrf` token.
- A session store with `revokeAllForUser(userId)`.
- Exact `(issuer, subject)` identity lookup and conflict-safe insertion.
- Phase A lifecycle state (`active`, `suspended`, `revoked`) with immutable identity ownership and append-only lifecycle history. Login resolution requires active lifecycle state.

The current login transaction store is purpose-built for unauthenticated login: its payload does not bind a transaction to an already authenticated internal user or distinguish link intent from login intent. The current BFF has no link/unlink endpoints, no step-up-authentication record, no identity-change audit workflow, and no transaction that atomically combines link state, security audit, and session revocation intent. The session store's user-wide revocation helper exists, but is not yet a complete identity-change workflow.

Phase B must add these capabilities without weakening the existing login path.

## 3. Security invariants

1. **Immutable ownership:** once `(issuer, subject)` is bound to an internal user, it is never reassigned. A conflict never triggers merge, transfer, or support override.
2. **Two independent proofs:** linking requires (a) recent step-up authentication to the already authenticated INFINYX account and (b) a fresh, independently validated OIDC authentication for the new identity.
3. **Server-derived actor:** the acting user is taken only from the active server-side session. No request parameter can select a different account.
4. **Single-use intent:** each link transaction is purpose-bound, user-bound, browser-bound, expiring, and consumed at most once, including failed callback attempts after a valid transaction has been claimed.
5. **No profile matching:** email, phone, username, display name, and provider profile similarity are never used to locate, merge, or authorize an account.
6. **Fail closed:** missing lifecycle state, stale step-up proof, CSRF failure, transaction mismatch, OIDC validation failure, database uncertainty, or audit failure prevents the mutation.
7. **Tenant independence:** identity workflows do not accept a tenant as authority and do not read or modify membership, roles, branch assignments, or tenant selection.
8. **Auditable mutation:** a successful identity mutation and its security audit record commit atomically. No secrets or raw provider tokens are logged.
9. **Session containment:** a security-sensitive identity change invalidates sessions according to the policy in section 9; revocation failure must never be reported as success.
10. **No implicit recovery:** suspended/revoked identities and lost-account scenarios are not silently repaired by ordinary linking or unlinking.

## 4. Proposed user journeys and API surface

Endpoint names are illustrative and may be adapted to the existing HTTP router.

### 4.1 Step-up authentication

- `POST /account/security/reauth` — requires an active session, exact Origin, and CSRF token. Initiates a fresh OIDC authorization challenge using an already linked, active identity.
- `GET /auth/reauth/callback` — validates the OIDC response and the dedicated reauthentication transaction. It must prove the same `(issuer, subject)` as an active identity already bound to the session's internal user.
- On success, store a server-side step-up grant with user ID, session-generation/session reference, authentication time, method/identity reference, and expiry. Proposed maximum age: **5 minutes**.
- A reauthentication callback must not create or alter an identity binding. It must not be accepted as proof of the *new* identity being linked.
- A step-up grant is single-purpose and consumed by the first sensitive mutation attempt. A failed policy check does not restore the grant.

### 4.2 Start linking

- `POST /account/identities/link` — requires active session, step-up grant no older than five minutes, exact Origin, and CSRF token.
- Server creates a separate link transaction with:
  - opaque transaction identifier and cryptographically random OIDC state and nonce;
  - PKCE verifier/challenge;
  - purpose fixed to `identity_link`;
  - internal user ID from the session;
  - initiating session identifier hash or session generation;
  - browser-binding secret hash;
  - creation and expiry timestamps (proposed five minutes);
  - expected issuer/client/redirect configuration version;
  - one-time consumption state.
- Persist hashes for opaque secrets and encrypt the verifier/nonce payload at rest using the established server-side encryption pattern. Never persist raw cookie/session secrets.
- Set a short-lived, Secure, HttpOnly, SameSite=Lax transaction cookie scoped narrowly to the callback path. Do not put user IDs or identity claims in the cookie.
- Redirect only to the configured OIDC authorization endpoint with Authorization Code + PKCE (S256), state, and nonce. Use an exact allow-listed redirect URI and fixed post-operation destination.

### 4.3 Complete linking

- `GET /auth/identity-link/callback` — validate callback origin/host routing and transaction cookie, then atomically claim/consume the transaction before processing the authorization response.
- Validate the OIDC response using the existing provider-neutral OIDC library and configured issuer/client:
  - exact issuer and expected client/audience (including `azp` where applicable);
  - signature and key selection from trusted discovery/JWKS;
  - state, nonce, PKCE, authorization-code one-time use, token time claims;
  - exact redirect URI and allowed response mode;
  - reject unexpected issuer, client, algorithm, redirect, or provider metadata.
- Derive the new identity only from the validated ID token's `iss` and `sub`. Normalize neither into a different identity; validate the issuer and subject according to the existing persistence contract.
- Re-check the initiating user is active, the initiating session is still valid, the session generation has not changed, and the step-up grant is still valid and bound to this transaction.
- In one database transaction, lock the internal user row and any existing identity/lifecycle row for the exact `(issuer, subject)`, then apply:
  - no existing binding: insert immutable identity binding; Phase A trigger initializes lifecycle as active and writes its creation event;
  - same user + active binding: return an idempotent `already_linked` outcome without creating a duplicate;
  - different user binding: deny with a generic conflict response; do not reveal owner or account existence;
  - suspended or revoked binding: deny ordinary linking; direct user to a separately approved recovery/security process; never auto-reactivate;
  - inactive/missing user or missing/inconsistent lifecycle state: deny.
- Write a security audit event in the same transaction as a new binding. For a same-user idempotent request, record an outcome event without creating a second lifecycle transition.
- Commit only if the binding operation and required audit write both succeed. On any failure, roll back and return a generic error.
- Do not automatically create a new INFINYX user from this callback.

### 4.4 Unlink an identity

- `POST /account/identities/:identityId/unlink` — requires active session, fresh step-up grant, exact Origin, CSRF token, and explicit confirmation.
- The server resolves `identityId` and verifies it belongs to the session's internal user. Never accept issuer/subject from the client as the unlink target.
- Lock the internal user and target lifecycle row; re-check ownership and active status inside the transaction.
- Evaluate the remaining sign-in/recovery methods under the approved account policy. Proposed Phase B minimum: at least one other active, usable sign-in identity must remain. If the target is the last usable identity, deny; do not implement recovery or a support override in Phase B.
- If allowed, transition the target lifecycle from active to revoked using the Phase A controlled transition mechanism and append the corresponding lifecycle and security audit records atomically. Preserve the immutable identity binding.
- A revoked identity is permanently ineligible for login and cannot be linked to another user. Reactivation for its original owner is not part of ordinary unlink; any such workflow requires a separate recovery decision.
- After commit, revoke sessions under section 9. If session revocation cannot be confirmed, return a failure/indeterminate response, emit an operational alert, and do not tell the user the operation fully succeeded.

## 5. Transaction and replay-protection model

Use a dedicated transaction table rather than overloading the unauthenticated login transaction payload. Proposed logical fields:

| Field | Purpose |
|---|---|
| `transaction_id` | Random opaque primary key |
| `purpose` | Fixed enum: `reauth`, `identity_link` |
| `user_id` | Server-derived internal user |
| `session_binding_hash` | Binds transaction to initiating session/generation |
| `browser_binding_hash` | Binds callback to initiating browser |
| `state_hash` | Hash of OIDC state |
| `encrypted_payload` | Encrypted nonce and PKCE verifier |
| `step_up_grant_id` | Reference to the one-time step-up proof, for link flow |
| `created_at`, `expires_at` | Short validity window |
| `consumed_at`, `outcome` | Atomic one-time consumption and terminal result |

Requirements:

- State, browser binding, and transaction IDs use a cryptographically secure random generator; store only keyed hashes or cryptographic hashes appropriate to high-entropy secrets.
- A conditional atomic update/claim (or equivalent row lock) changes an unconsumed, unexpired transaction to consumed exactly once. Concurrent callbacks yield one winner.
- Consume the transaction before token exchange so retries cannot replay the same authorization code/intent. If downstream processing fails, require a new flow.
- Bind purpose, user, session generation, browser binding, expected issuer/client, and redirect URI. A transaction created for login or reauthentication must never be accepted by the link callback.
- Enforce a unique state hash and a cleanup policy for expired/consumed records. Retain minimal security metadata for a bounded audit window; do not retain encrypted verifier payload beyond operational need.
- A failed or conflicting callback is terminal. Do not allow it to be retried with another subject or browser.
- Callback handling must reject missing, duplicated, malformed, oversized, or ambiguous state/code parameters.

## 6. CSRF, browser, and redirect protections

- All state-changing initiation and unlink endpoints require exact configured Origin plus the existing synchronizer CSRF token. Reject absent, multiple, malformed, or non-canonical Origin values.
- Use POST for initiation and unlink. GET callbacks are allowed only as protocol callbacks and must be protected by OIDC state, nonce, PKCE, browser binding, and one-time transaction consumption; callbacks must not accept arbitrary mutation parameters.
- Use Secure, HttpOnly, SameSite=Lax cookies with narrow Path and short Max-Age for the transaction binding. The session cookie remains server-managed.
- Do not use wildcard redirect URIs, client-supplied return URLs, or open redirects. Return to a fixed local account-security page.
- Do not place state, tokens, identity claims, or sensitive identifiers in application logs, analytics, URLs beyond required protocol parameters, or browser storage.
- Apply request size limits, method allow-lists, rate limits per account/session/IP risk bucket, and generic error messages. Rate-limit responses must not reveal whether an identity is registered.

## 7. Conflict handling and lifecycle policy

| Observed state | Link behavior | Unlink behavior |
|---|---|---|
| No binding exists | Create binding for authenticated user | Not applicable |
| Active binding belongs to same user | Idempotent success/no duplicate | May revoke if another usable sign-in method remains |
| Active binding belongs to another user | Generic conflict; no disclosure or transfer | Deny; target is not owned by actor |
| Suspended binding | Deny; security/recovery review required | Do not mutate through link flow |
| Revoked binding | Deny; never reassign | Already unlinked; safe generic idempotent response only after ownership check |
| User inactive or lifecycle missing/inconsistent | Deny | Deny |

No ordinary Phase B path may change a lifecycle state from suspended or revoked back to active. No account merge, ownership transfer, or manual support reassignment is allowed.

## 8. Security audit model

Proposed append-only event types:

- `external_identity.reauth_started`
- `external_identity.reauth_succeeded`
- `external_identity.reauth_denied`
- `external_identity.link_started`
- `external_identity.link_succeeded`
- `external_identity.link_idempotent`
- `external_identity.link_denied`
- `external_identity.unlink_succeeded`
- `external_identity.unlink_denied`
- `user_sessions.revocation_requested`
- `user_sessions.revocation_completed`
- `user_sessions.revocation_failed`

Minimum metadata: event ID, event timestamp, actor internal user ID (or system actor), target internal user ID, opaque identity reference when applicable, operation/decision, reason code, correlation ID, and privacy-minimized request context.

Never record access/refresh/ID tokens, authorization codes, client secrets, PKCE verifiers, raw state/nonce, session IDs/cookies, full ID-token claims, or raw provider responses.

**Atomicity:** successful link/unlink state and its audit event must commit together. Session revocation is a separate side effect after commit; use a durable outbox/revocation job written in the same database transaction so a process crash cannot silently lose the revocation request. Mark the outbox item complete only after revocation is confirmed. Alert and retry safely on failure. The UI must distinguish completed from pending/indeterminate revocation.

A general security-audit table/outbox schema is a proposed addition and must be reviewed for retention, access controls, append-only enforcement, and privacy before migration approval. Phase A lifecycle events remain the source of truth for lifecycle transitions; do not duplicate or mutate them.

## 9. Session rotation and revocation policy

Recommended default for Phase B:

- **After successful link:** create a replacement session for the same internal user with a new opaque session ID and new CSRF token; revoke all prior sessions for that user, including the initiating session, then issue only the replacement cookie after revocation is confirmed. This prevents a stolen pre-link session from remaining valid. Provider tokens remain server-side. If replacement-session creation or revocation fails, fail closed, clear browser cookies, and require a fresh login.
- **After successful unlink:** revoke all sessions for the user, including the current session, and clear the session cookie. Require a fresh login through a remaining active identity. No replacement session is issued from the just-unlinked session.
- **After denied/idempotent link:** no identity mutation. Rotate neither identity nor session by default; record rate-limited security outcome. If policy detects suspicious activity, revoke sessions through a separate incident response path.
- **On revocation job failure:** keep the operation in a non-success/indeterminate state, retry idempotently, alert operations, and prevent any newly issued session from bypassing the required policy.

The implementation must define transaction boundaries and ordering so there is no interval in which the old session remains accepted after the operation is reported successful. Session validation must reject revoked sessions on every request.

## 10. Database and concurrency requirements

- Use parameterized SQL, explicit transactions, row locks, and bounded lock timeouts.
- Lock order must be documented and consistent (internal user row, identity row, lifecycle row, then audit/outbox rows) to reduce deadlocks.
- Enforce unique constraints for state hash/transaction identifiers and one-time step-up grant consumption.
- The exact external identity uniqueness constraint remains authoritative. Never use a read-then-insert sequence without database conflict handling.
- Re-check account active status, ownership, lifecycle state, step-up freshness, and remaining sign-in method count inside the transaction immediately before mutation.
- Concurrent link attempts for the same `(issuer, subject)` must produce exactly one immutable binding. Same-user races may converge to an idempotent result; different-user races must produce one winner and one generic conflict.
- Concurrent unlink attempts must produce at most one lifecycle transition and one effective revocation request.
- Audit/outbox insertion failure rolls back the identity mutation.
- Do not change or rewrite existing identity rows or Phase A backfill records.
- Any migration must be additive, reversible only when no operational data would be destroyed, and tested against a copy of the current schema/data before execution. If pre-existing data or constraints create ambiguity, stop and report before migration.

## 11. Threat model and mitigations

| Threat | Required mitigation |
|---|---|
| Stolen existing session | Fresh step-up proof; session binding; revoke prior sessions after link/unlink |
| Attacker links their identity to victim | Reauthentication to victim's existing method plus independently validated new identity; explicit user intent |
| Identity transfer/account takeover | Immutable owner; conflict denial; no email/phone matching |
| Callback replay | Atomic one-time transaction consumption; short expiry; terminal failure |
| CSRF/login CSRF | Exact Origin + synchronizer token for mutations; state/nonce/PKCE/browser binding for callback |
| Cross-browser callback injection | Browser-binding cookie and initiating-session binding |
| OIDC mix-up/provider substitution | Fixed issuer/client/redirect config; validate issuer, audience, nonce, signature and PKCE |
| Concurrent duplicate links | Unique DB constraint, row locks, conflict-safe insert, race tests |
| Unlink last sign-in method | Transactional remaining-method check; deny |
| Session survives unlink | Durable revocation outbox, revoke-all, session validation and retry/alert |
| Account enumeration | Generic conflict/failure responses; no other owner's identifiers |
| Audit tampering or secret leakage | Append-only controls, restricted role, redaction, tests |

## 12. Required test plan

### Unit and handler tests
- Step-up grant creation, expiry at boundary, user/session binding, purpose binding, one-time consumption.
- Link initiation rejects missing session, inactive user, missing/stale step-up, wrong Origin, missing/invalid CSRF, and rate-limit violations.
- Callback rejects missing/duplicate state or code, expired/consumed transaction, wrong browser, wrong session, wrong user, wrong purpose, and configuration mismatch.
- OIDC validation rejects wrong issuer, audience/authorized party, nonce, signature/key, PKCE, redirect URI, algorithm, and expired/not-yet-valid token.
- Provider email/phone/profile claims do not influence user resolution or authorization.
- Generic conflict response does not disclose whether another account owns the identity.
- Suspended, revoked, missing lifecycle, and inactive-user cases fail closed.
- Unlink rejects a target not owned by the session user and rejects removal of the last usable sign-in method.
- No sensitive token, code, cookie, verifier, raw claim, or raw OIDC response appears in logs/audit events.

### PostgreSQL integration and concurrency tests
- Two simultaneous users attempt to link the same identity: exactly one binding; loser receives generic conflict; original owner remains unchanged.
- Two simultaneous same-user attempts: one binding and one safe idempotent outcome; no duplicate lifecycle event.
- Duplicate callback races: exactly one transaction consumer succeeds.
- Expired and consumed transaction rows cannot be claimed.
- Concurrent unlink attempts: one state transition and one effective revocation outbox item.
- Audit insertion failure rolls back link/unlink mutation.
- Outbox retry is idempotent; completed revocation cannot be undone by retry.
- Last-identity check is serialized with link/unlink changes to avoid write-skew.
- Session revocation makes every prior session fail `findActive`; replacement session after link has a new session ID and CSRF token.
- Existing Phase A ownership immutability, revoked-login denial, lifecycle append-only history, and legacy backfill tests remain green.

### Acceptance criteria (all mandatory)
1. No link without both independent proofs.
2. No identity ownership transfer or account merge under any tested path.
3. No successful replay, cross-browser callback, wrong-purpose callback, or CSRF bypass.
4. No duplicate identity binding under concurrency.
5. No unlink that removes the final approved sign-in path.
6. No successful response while required session revocation is unconfirmed.
7. Link/unlink mutation and security audit are atomic.
8. All pre-existing identity bindings and Phase A history remain unchanged.
9. Tenant membership/roles/branch access are neither read as authentication authority nor modified.
10. Existing test suite and new security/integration tests pass in CI before implementation can be considered complete.

## 13. Proposed implementation sequence — requires separate approval

If approved later, implementation should be split into reviewable sub-steps:

- **B1 — transaction and step-up foundation:** purpose-bound transaction persistence, step-up grants, expiry/consumption semantics, tests; no user-visible link/unlink endpoint until foundations pass.
- **B2 — link flow:** BFF initiation/callback, validated new identity proof, immutable conflict handling, audit, session replacement/revocation outbox, tests.
- **B3 — unlink flow:** ownership checks, last-method guard, lifecycle revocation, audit/outbox, session revocation, tests.
- **B4 — hardening and verification:** concurrency, replay, CSRF, failure injection, log redaction, full CI verification and documentation.

Each sub-step needs explicit scope approval before code or migration changes. Phase C remains separate.

## 14. Decisions requested before implementation

Recommended defaults for founder review:

1. Step-up freshness: **5 minutes**, one-time and bound to user + initiating session.
2. Link transaction lifetime: **5 minutes**, single-use, browser- and session-bound.
3. Successful link session policy: **replace current session and revoke all prior sessions** for that user.
4. Successful unlink session policy: **revoke all sessions**, clear current cookie, require fresh login.
5. Unlink guard: require **at least one other active usable sign-in identity**; no last-method unlink.
6. Recovery: **deferred**; no self-service lost-account recovery or support override in Phase B.
7. Reactivation: no ordinary Phase B reactivation of suspended/revoked identities; never reassign ownership.
8. Notifications: send a security notification only through an already verified channel available to the account; if no verified channel exists, record the gap and do not invent a channel. Notification delivery must not become proof of identity.
9. Audit retention and user-visible notification copy: finalize privacy/retention policy before implementation.

Founder approval of these defaults and this document would still not authorize implementation automatically. The exact B1–B4 execution scope, migration plan, CI changes, and risks must be presented for separate approval.

## 15. Explicit non-goals

- Phase C recovery, lost-account recovery, identity reactivation workflow, support-assisted recovery.
- Tenant membership, role, branch, or permission changes.
- Provider-specific social-login implementations or account provisioning.
- Account merge, identity reassignment, email/phone matching.
- Keycloak configuration or realm/client changes.
- Public staging, production deployment, merge to `main`, release, or publication.
- Any code, schema, CI, or infrastructure change as part of this design-only deliverable.

**Current status:** Design document only. No application code, database migration, Keycloak configuration, CI workflow, deployment, merge, or release was changed or initiated for Phase B.
