# Phase B — Secure External Identity Link/Unlink Workflow Design

**Status:** Proposed — design only; implementation requires separate founder approval  
**Repository:** `hamidyaghobi70-beep/infinyx`  
**Branch:** `feat/adr-platform-foundation`  
**Depends on:** Phase A lifecycle foundation and the accepted External Identity Lifecycle Security Design  
**Scope:** Secure, user-initiated external identity linking and unlinking through the Web BFF

## 1. Purpose and explicit boundary

Phase B turns the Phase A lifecycle tables into controlled user-facing security workflows. It does not implement lost-account recovery, provider administration, tenant membership changes, production deployment, or a persistent Keycloak environment.

This document is a design artifact only. It authorizes no code changes, migrations, CI runs, Keycloak configuration, deployment, merge, or release.

### Non-negotiable invariants

1. An external identity is the exact validated pair `(issuer, subject)`; profile attributes are never identity keys.
2. An existing `(issuer, subject) -> internal user` binding is immutable and is never transferred.
3. Linking requires fresh proof of control of the existing INFINYX account and independent proof of control of the new external identity.
4. A browser session alone is insufficient proof for linking or unlinking.
5. Every transaction is purpose-bound, user-bound, browser-bound, short-lived, and single-use.
6. All uncertain, stale, conflicting, disabled, or partially completed states fail closed.
7. Identity lifecycle changes and their security audit records are atomic.
8. Tenant IDs, tenant roles, branch permissions, and provider claims are not inputs to identity ownership decisions.
9. Provider tokens remain server-side. No credential, authorization code, token, raw OIDC claim set, or session cookie is logged.
10. Phase B does not provide a support-agent override or lost-account recovery path.

## 2. Current foundation and integration constraints

Phase A provides:
- Immutable identity bindings in `user_external_identities`.
- Lifecycle projection states `active`, `suspended`, and `revoked`, with append-only lifecycle events.
- Login resolution restricted to active identities; missing/inactive lifecycle state fails closed.
- Database uniqueness for the immutable identity pair and concurrent-link protection.
- A server-side session store, CSRF validation, and an OIDC login transaction store.
- A BFF login callback that currently rejects unknown identities.

Important implementation boundary: the existing persistence linking primitive is not, by itself, a proof-of-ownership workflow. Phase B must not expose that primitive directly to a route or browser. A new application service must require a consumed, validated link authorization context before it can create a binding.

The existing session store has `revokeAllForUser`, but it is not yet a transaction-aware identity-lifecycle operation. Phase B must make the mutation, audit record, and local session revocation consistent; a best-effort upstream token revocation must never be confused with authoritative local session invalidation.

The current BFF has fixed routes and a generic single-issuer configuration. Multi-provider support must use server-configured provider identifiers mapped to pinned issuer/client configuration. A browser must never supply an arbitrary issuer, discovery URL, token endpoint, or JWKS URL.

## 3. Proposed service boundaries

Keep protocol handling, policy, persistence, and session operations separate:

- **BFF route handlers:** validate HTTP method, request size, exact Origin, session cookie, and CSRF; return generic responses.
- **Identity-link orchestration service:** owns the state machine and calls reauthentication, OIDC verification, policy, persistence, audit, and session services.
- **Step-up verifier:** verifies a fresh authentication event for an already-linked active identity and binds it to the initiating internal user and session.
- **OIDC link callback verifier:** validates the new provider authentication using the existing OIDC library and a server-selected provider configuration.
- **Identity lifecycle repository:** performs locking, exact-pair lookup, immutable binding insertion, and lifecycle reads/writes inside a caller-owned database transaction.
- **Audit writer:** inserts privacy-minimized security events in the same transaction as the identity mutation.
- **Session lifecycle service:** rotates or revokes local server-side sessions using transaction-aware methods.
- **Provider registry:** maps an opaque configured provider key to a fixed issuer, client ID, secret reference, and redirect URI. It is not a dynamic URL resolver.

No route should call low-level identity insertion or lifecycle update SQL directly.

## 4. Linking workflow

### 4.1 API surface (proposed)

Use explicit BFF routes, all same-origin and non-cacheable:

- `POST /api/identity-links` — begin linking; requires active session, CSRF, exact Origin, and recent step-up authentication.
- `GET /auth/identity-link/callback` — complete the new-provider OIDC proof; browser-bound one-time transaction.
- `GET /api/identity-links` — list only the current user's own linked identities with safe display metadata.
- `POST /api/identity-links/:linkId/unlink` — request unlink; requires step-up, CSRF, explicit confirmation, and policy checks.

The `linkId` is an opaque internal reference, not an issuer/subject value. The list endpoint must not expose raw subject identifiers or disclose identities owned by another user.

The final route names may be adjusted to match repository conventions, but the security properties and HTTP method semantics are mandatory. No GET request may mutate state.

### 4.2 Two independent proofs

**Proof 1 — existing account control**
- Require an authenticated, non-disabled internal user and a currently active linked identity.
- Require a new step-up authentication against an identity already linked to this same internal user. Do not treat the existing session age or a recently refreshed access token as step-up proof.
- Use an explicit reauthentication challenge (for example OIDC `prompt=login` and an appropriate `max_age` policy where supported), and validate the returned authentication time and provider assurance claims according to the configured provider policy.
- Proposed freshness limit: 5 minutes from verified reauthentication to final link completion.
- Bind the proof to the current internal user, current session generation, browser binding, provider configuration, and a one-time transaction.
- If the provider cannot produce adequate reauthentication evidence, linking is unavailable for that provider; do not silently downgrade.

**Proof 2 — new external identity control**
- Start a separate OIDC Authorization Code + PKCE transaction against a server-selected, preconfigured provider.
- Validate signature, exact issuer, audience/authorized party, nonce, state, PKCE, time claims, redirect URI, and allowed algorithm using the OIDC library and pinned provider configuration.
- The resulting exact `(issuer, subject)` must be derived only from validated ID-token claims.
- The new identity must not be accepted merely because its email or phone matches the current account.

The two proofs must be distinct protocol events. A single provider response, an email match, or the pre-existing session cannot satisfy both.

### 4.3 Transaction state machine

Suggested states:

`created -> step_up_verified -> provider_auth_pending -> completed`

Terminal failure states: `denied`, `expired`, `cancelled`, `consumed`.

Rules:
- Generate at least 256 bits of cryptographic randomness for state and browser binding; use PKCE S256.
- Store only hashes for opaque state and browser-binding values. Encrypt sensitive transaction payloads with authenticated encryption and purpose-specific associated data.
- Persist the intended internal user ID, initiating session hash/generation, configured provider key, fixed callback identifier, transaction purpose, creation/expiry times, and proof timestamps.
- Proposed maximum transaction lifetime: 5 minutes after step-up. Expire immediately if the initiating session is revoked, rotated, or no longer belongs to the same active user.
- Consume the transaction atomically before performing the identity mutation. Duplicate callbacks must not be retryable.
- Bind the callback to the same browser cookie and exact expected purpose. Wrong browser, wrong user, wrong provider, wrong callback, stale session, or expired transaction is denied.
- Do not put user IDs, tenant IDs, provider secrets, or redirect destinations in untrusted state parameters.
- Do not accept caller-controlled post-authentication redirect destinations.

### 4.4 Atomic identity decision

After successful callback validation and transaction consumption, perform one database transaction:

1. Lock the internal user row and verify it remains active.
2. Lock or serialize access to the exact issuer/subject key using the repository's database-safe uniqueness strategy.
3. Re-check that the initiating session and step-up proof remain valid.
4. Look up the exact immutable identity binding and its lifecycle state.
5. Apply exactly one outcome:
   - **No binding exists:** create the immutable binding for the initiating internal user; Phase A's initialization trigger creates its active lifecycle projection and creation event.
   - **Already bound to this same user and active:** return an idempotent “already linked” outcome; do not create duplicate history or rotate ownership.
   - **Bound to a different user:** deny with a generic conflict. Do not reveal whether the identity exists or identify its owner.
   - **Suspended or revoked:** deny normal linking. Do not reactivate or create a replacement binding. Recovery/reactivation is out of Phase B.
6. Insert the corresponding audit event in the same transaction.
7. Rotate the current session to a fresh session ID and fresh CSRF token, and revoke prior sessions according to the session policy below. Commit all local changes atomically.

If any database, audit, or session mutation fails, roll back the identity mutation and report a generic failure. A callback transaction already consumed remains consumed; the user must start a new flow.

## 5. Unlink workflow

### 5.1 Preconditions

Unlink is a high-impact authenticated action. Require:
- Active internal user and active server-side session.
- Fresh step-up reauthentication, proposed maximum age 5 minutes.
- Exact Origin and synchronizer CSRF token.
- Explicit user confirmation identifying the sign-in method with safe display metadata.
- A valid opaque link reference belonging to the current user.
- A policy check proving that at least one approved sign-in/recovery path remains after removal.

Do not infer remaining methods from provider email, phone, or unverified account profile data. Phase B must not invent a recovery path. If the account does not have another approved active method, deny unlink and explain generically that another sign-in method must be established first.

### 5.2 Atomic unlink

Within one database transaction:
1. Lock the user row and target identity/lifecycle row.
2. Re-check user active status, ownership, active lifecycle state, step-up freshness, CSRF request authorization, and remaining approved sign-in/recovery paths.
3. Transition the target lifecycle projection from `active` to `revoked` using the Phase A transition invariants; never update or delete the immutable identity binding.
4. Insert an append-only unlink audit event.
5. Revoke all local web sessions for the internal user, including the initiating session, in the same transaction.
6. Commit. The browser receives an expired session cookie and must authenticate again using a remaining active method.

If the audit or local session revocation write fails, roll back the lifecycle transition. Upstream OIDC refresh-token revocation is best effort after commit; local session revocation is authoritative. Record operational failure without leaking token material.

### 5.3 Concurrent operations

- Serialize link/unlink decisions on the internal user and relevant identity key.
- Re-evaluate the “last approved method” rule while holding the relevant locks.
- Two concurrent unlink attempts must not both remove the final methods.
- A callback racing with unlink or suspension must re-read lifecycle state under transaction locks and deny if the identity is no longer active.
- A uniqueness conflict is a safe conflict result, never a reason to retry with a different owner.

## 6. Session policy

Recommended conservative policy:

**After successful link:** create a fresh session for the same internal user with a new random session ID and CSRF token, then revoke every previous local session for that user in the same transaction. This limits persistence of a potentially stolen session after a security-sensitive account change. The user remains signed in only through the newly rotated session.

**After successful unlink:** revoke every local session for the user, including the current one, and require fresh login.

Additional requirements:
- Session rotation must preserve only the validated current authentication context; it must not copy untrusted browser-supplied values.
- The new session must be bound to a still-active identity and a newly validated server-side token bundle.
- If replacement-session creation or old-session revocation cannot be committed atomically, roll back the link.
- Do not claim that upstream provider tokens were revoked unless the provider confirms it. Local server-side session invalidation remains the source of truth for INFINYX.
- Session revocation must be idempotent and safe under concurrent requests.
- Recovery, account disablement, credential reset, and compromise wiring remain Phase C.

## 7. Suspension, revocation, and conflicts

Phase A lifecycle semantics remain authoritative:

- `active`: eligible for login and eligible to be selected for unlink.
- `suspended`: login denied; normal link and unlink flows cannot reactivate it.
- `revoked`: terminal for the existing immutable binding; never eligible for login or reassignment.

Phase B does not add a user-facing suspension or reactivation API. Security/admin suspension controls and reactivation policy require a separately authorized design. If a link attempt encounters suspended or revoked state, deny generically and direct the user to the separately governed recovery/support process without confirming account ownership.

For a conflict where the new identity is already owned by another user:
- Return a generic conflict such as `identity_link_unavailable`.
- Do not disclose the other user's existence, identifier, tenant, email, phone, or provider metadata.
- Do not offer automatic account merge, ownership transfer, or support reassignment.
- Emit a privacy-minimized denied audit event, subject to safe retention policy.

## 8. CSRF, replay, and protocol defenses

- Mutating routes require exact configured Origin and synchronizer CSRF validation.
- SameSite cookies are defense in depth, not a replacement for CSRF checks.
- No state change via GET.
- Enforce strict request body size, content type, method, and schema validation.
- Use separate transaction purpose labels and cryptographic AAD for login, step-up, and identity-link transactions.
- Require one-time state and nonce; atomically consume state before mutation.
- Reject duplicate callbacks, expired state, state from another browser, stale session generation, wrong user, and wrong provider.
- Use fixed callback and fixed post-operation paths.
- Provider endpoints are loaded only from trusted configuration; HTTPS required; redirects rejected; bounded timeouts and response sizes.
- Do not use wildcard redirect URIs or trust the request Host header.
- Rate-limit link starts, step-up attempts, callback failures, and unlink attempts by account and privacy-safe network signals. Rate-limit design must avoid creating an account-enumeration oracle.
- Security errors exposed to browsers remain generic; detailed causes are available only in protected operational telemetry.

## 9. Security audit model

Proposed event types:
- `external_identity.link_started`
- `external_identity.link_step_up_succeeded`
- `external_identity.link_succeeded`
- `external_identity.link_denied`
- `external_identity.unlink_started`
- `external_identity.unlink_succeeded`
- `external_identity.unlink_denied`
- `user_sessions.rotated_for_identity_link`
- `user_sessions.revoked_for_identity_unlink`

Minimum metadata:
- event ID and UTC timestamp;
- actor and target internal user IDs;
- opaque identity binding reference (never raw subject);
- provider configuration key or privacy-safe issuer reference;
- outcome and enumerated reason code;
- correlation ID and transaction reference;
- safe request context needed for incident investigation.

Never store access/refresh/ID tokens, authorization codes, PKCE verifier, raw claims, client secrets, cookies, CSRF tokens, full callback URLs, or unredacted provider responses. Audit insertion must be in the same database transaction as successful state changes. Denied attempts may be written as separate audit-only transactions with strict data minimization.

## 10. Database and authorization requirements

- Keep `user_external_identities` immutable and retain the Phase A lifecycle triggers and append-only event history.
- Use parameterized SQL and explicit transactions.
- Do not let the route or general application role mutate lifecycle rows directly.
- Define a narrowly scoped persistence capability for creating a new identity binding only after the orchestration service has validated the one-time authorization context. The database must continue to enforce exact-pair uniqueness and immutable ownership.
- Restrict lifecycle transitions to a dedicated repository/service path; no client-supplied actor or user ID is trusted.
- Verify that the database role used by the BFF has only the minimum grants required. Any grant change or security-definer function requires explicit review in the implementation proposal.
- Preserve migration safety: no rewriting or reassignment of existing identity rows; no destructive backfill; down migrations must not erase identity lifecycle or audit history.
- Identity workflows must not set tenant context or bypass tenant RLS for business data. The only internal user authority is derived from the validated session and database mapping.

## 11. Required tests and acceptance criteria

Implementation is not acceptable until automated tests demonstrate all of the following:

### Positive cases
1. A link succeeds only with fresh step-up proof for the current user and a separately verified new OIDC identity.
2. Same-user, already-active duplicate link returns a safe idempotent result.
3. Successful link creates exactly one immutable binding, one active lifecycle projection, and one corresponding audit event.
4. Successful link rotates the session ID and CSRF token and invalidates prior sessions.
5. Successful unlink revokes the target lifecycle state, writes its audit event, revokes all local sessions, and expires the browser cookie.

### Negative and protocol cases
6. Missing, stale, invalid, wrong-user, wrong-session, wrong-browser, wrong-purpose, or replayed transaction is rejected.
7. Missing/invalid CSRF, mismatched Origin, unsafe HTTP method, malformed body, and caller-controlled redirect are rejected.
8. Invalid issuer, audience/authorized party, nonce, state, PKCE, signature, time claims, redirect URI, or provider configuration is rejected.
9. Email/phone/profile similarity never links identities.
10. Identity owned by another user returns a generic conflict and reveals no owner metadata.
11. Suspended or revoked identity cannot authenticate, link, unlink, or be silently reactivated.
12. Disabled user cannot start or complete link/unlink.
13. Unlink that would remove the last approved sign-in/recovery path is denied.
14. Failure to write audit or revoke local sessions rolls back the lifecycle mutation.
15. No token, authorization code, secret, raw claim, cookie, or CSRF token appears in logs or audit records.

### Concurrency and database cases
16. Concurrent attempts to link the same identity produce one immutable owner and one safe conflict.
17. Concurrent unlink attempts cannot remove the final approved authentication path.
18. Link callback racing with unlink/suspension cannot create an active session from an inactive identity.
19. Database constraints reject duplicate bindings, invalid lifecycle transitions, identity reassignment, and event mutation.
20. Session revocation is idempotent and race-safe.

### Build and CI evidence
21. Unit, integration, migration syntax, migration apply/backfill, typecheck, build, dependency audit, and ephemeral OIDC integration checks pass.
22. Tests use synthetic identities and secrets only; no live provider account or production credential is used.

## 12. Delivery slices proposed for a later implementation approval

If the founder approves implementation after reviewing this design, split Phase B into separately reviewable slices:

- **B1 — Transaction and step-up foundation:** purpose-bound transaction storage, reauthentication proof model, provider registry contract, replay/CSRF tests. No identity mutation endpoint yet.
- **B2 — Link orchestration:** callback validation, exact-pair conflict handling, atomic identity insert/audit, session rotation/revocation.
- **B3 — Unlink workflow:** safe linked-method listing, last-method policy, lifecycle revocation, audit, all-session invalidation.
- **B4 — Hardening and verification:** concurrency, failure-injection, database privilege, log-redaction, migration and CI acceptance evidence.

Each slice needs an explicit scope approval before code changes. A later implementation request must specify which slices are authorized.

## 13. Risks and mitigations

| Risk | Mitigation / stop condition |
|---|---|
| Provider cannot prove recent reauthentication | Disable linking for that provider; do not weaken proof requirements. |
| Existing BFF is configured for only one issuer | Add a pinned provider registry only under approved scope; never accept arbitrary issuer URLs. |
| Link mutation bypasses proof workflow | Keep low-level persistence primitive private; require consumed authorization context and tests. |
| Audit/session changes cannot be atomic | Stop and redesign transaction boundaries before implementation. |
| Last-method policy is ambiguous | Do not implement unlink until approved sign-in/recovery methods are explicitly defined. |
| Concurrent link/unlink race | Lock rows, enforce uniqueness, re-check policy inside transaction, test race outcomes. |
| Provider token revocation fails | Local session revocation remains authoritative; surface operational alert and do not claim upstream revocation. |
| Existing identity records require modification | Stop; no legacy binding rewrite or reassignment is in Phase B. |
| Database privileges require broad grants | Stop and present a least-privilege alternative before changing grants. |
| Rate limits or notifications require external services | Keep external delivery out of scope until separately approved. |

## 14. Founder decisions required before implementation

The following decisions should be resolved before approving any implementation slice:

1. **Step-up freshness:** approve the proposed 5-minute maximum age for link and unlink.
2. **Session policy:** approve revoking all previous sessions after link (while issuing one fresh replacement session), and revoking all sessions after unlink.
3. **Approved sign-in/recovery methods:** define what qualifies as an alternative method for the last-method check. The safest initial option is to permit unlink only when another active, independently verified sign-in method exists; do not count an unimplemented recovery channel.
4. **Provider scope:** confirm which configured OIDC provider(s) are in the first implementation. No arbitrary provider discovery.
5. **Notifications:** decide whether link/unlink notifications are required for the first implementation and which already verified channel can deliver them. If no safe channel exists, explicitly accept that limitation or defer the affected operation.
6. **Rate limiting:** approve initial conservative account and network limits after the implementation proposal quantifies them.

## 15. Explicit exclusions

- Lost-account recovery and reactivation of suspended/revoked identities (Phase C).
- Identity reassignment, account merging, email/phone matching, and automatic provisioning.
- Support-agent override or manual database repair.
- Tenant membership, role, branch, billing, or business-data changes.
- Arbitrary/dynamic OIDC provider registration.
- Persistent Keycloak staging, public exposure, production deployment, merge, and release.

**Current status:** Design only. No source code, migration, Keycloak configuration, CI workflow, deployment, merge, or release changes are authorized or performed by this document.
