# External Identity Linking, Unlinking, and Recovery — Security Design

**Status:** Approved security design baseline; phased implementation is tracked in separate engineering records  
**Repository:** `hamidyaghobi70-beep/infinyx`  
**Branch:** `feat/adr-platform-foundation`  
**Scope:** External identity lifecycle for the existing provider-neutral OIDC and Web BFF foundation

## 1. Purpose and security invariants

The current foundation deliberately maps an external OIDC identity to an internal INFINYX user by the exact pair `(issuer, subject)`. Unknown identities fail closed. There is no email/phone-based account linking or automatic account provisioning.

This design adds a safe lifecycle around that mapping without weakening those guarantees.

Non-negotiable invariants:

1. An external identity is identified only by its validated `(issuer, subject)` pair. Email, phone, display name, username, and provider profile claims are never identity keys.
2. Linking requires two independent proofs in the same short-lived flow: recent reauthentication to the existing INFINYX account and successful authentication of the new external identity.
3. No operation may transfer an existing external identity binding from one internal user to another.
4. Unknown, conflicting, expired, replayed, disabled, or unverifiable states fail closed.
5. Tenant membership, tenant roles, branch access, and tenant selection remain independent of authentication-provider claims.
6. No account may be left without an approved recovery path by an unlink operation.
7. Sensitive lifecycle changes are auditable; tokens, authorization codes, secrets, raw claims, and session cookies are never written to audit logs.
8. All operations are tenant-independent identity operations and must not infer or mutate tenant membership.

## 2. Current-state boundary

The current implementation provides exact issuer/subject mapping, database uniqueness, immutable identity rows, fail-closed login for unknown identities, and race-condition protection for conflicting links.

The persistence linking primitive expects its caller to have established proof and authorization. It is not itself a complete user-facing proof-of-ownership workflow. The session store has a `revokeAllForUser` helper, but account lifecycle events do not yet invoke it.

This proposal does not assume that those missing workflows already exist.

## 3. Proposed identity lifecycle model

### 3.1 Preserve immutable identity bindings

Keep the existing external identity binding immutable. Do not repurpose its issuer/subject pair and do not silently change its owning internal user.

Represent lifecycle state separately, using an append-only event history and a transactionally maintained current-state projection (or an equivalent design with enforceable database constraints):

- `active`: eligible for authentication.
- `suspended`: temporarily blocked pending security review or recovery.
- `revoked`: no longer eligible for authentication.
  
The implementation must enforce at most one active owner for an exact issuer/subject pair. A revoked binding must not become claimable by another user. Re-activation, if supported, may only restore the same immutable binding to the same internal user after fresh proof and policy checks.

The authoritative lookup used by login must require both the immutable binding and its current active lifecycle state. Missing or inconsistent state must deny authentication.

### 3.2 Link a new external identity

Proposed sequence:

1. The user starts from an authenticated INFINYX session and explicitly chooses **Add sign-in method**.
2. The BFF checks the internal user is active and requires step-up reauthentication to an already linked identity. Reauthentication must be recent (proposed maximum age: 5 minutes) and bound to the current session and user.
3. The server creates a short-lived, single-use link transaction (proposed lifetime: 5 minutes) with cryptographically random state, nonce, PKCE verifier/challenge, browser binding, expected purpose, and internal user ID. Store only protected or hashed transaction material as appropriate.
4. The user authenticates with the new OIDC provider. The callback validates issuer, signature, audience/authorized party, nonce, state, PKCE, time claims, and exact redirect configuration using the OIDC library.
5. The callback atomically consumes the transaction and verifies its purpose, browser binding, expiry, and intended internal user.
6. In one database transaction, lock the relevant identity and user rows, then:
   - If the exact identity is not bound, create the immutable binding and active lifecycle state.
   - If it is already bound to this same user and active, return a safe idempotent outcome.
   - If it is bound to another user, deny the operation with a generic conflict response. Never disclose the other account.
   - If it is already revoked or suspended, require the dedicated recovery/reactivation policy; do not silently reactivate.
7. Rotate the current session identifier and CSRF token. Revoke other sessions for the user as a conservative default, or document and justify a narrower policy before implementation.
8. Write an audit event in the same transaction as the successful lifecycle mutation.

Do not use provider email, phone, `email_verified`, or profile similarity to discover or merge accounts.

### 3.3 Unlink an external identity

1. Require an authenticated session, recent step-up reauthentication, CSRF validation, and explicit confirmation naming the sign-in method being removed.
2. Before mutation, calculate the user's remaining active authentication and recovery methods under a documented account policy.
3. Deny unlink if it would leave the account without at least one approved sign-in/recovery path. Do not allow support staff to bypass this invariant through an informal override.
4. Lock the user and identity lifecycle rows and re-check all conditions inside the transaction.
5. Append a revocation event and update the current-state projection atomically. Preserve the immutable original binding for audit and anti-reassignment.
6. Revoke all sessions for that internal user, including the current session, after the transaction commits; require a fresh login. If reliable revocation cannot be completed, fail closed and raise an operational security alert.
7. Record the actor, target internal user, identity binding reference, reason category, timestamp, outcome, and correlation ID. Do not log provider tokens or raw claims.

### 3.4 Recovery and reactivation

Recovery is a separate, high-risk workflow and must not be conflated with ordinary linking.

- Prefer proof through an already active sign-in method or a pre-established recovery method.
- If all active methods are lost, require a separately designed, rate-limited recovery process with strong proof, delayed completion where appropriate, user notification through previously verified channels, and security-event review.
- Support personnel must not be able to assign an external identity based only on an email address, phone number, screenshot, or verbal request.
- Recovery must never reassign an identity already bound to a different internal user.
- Any exceptional recovery action must require dual control, a reason code, an immutable audit record, and a notification path. No support override is included in the MVP proposal.
- After recovery, revoke all existing sessions and require fresh authentication.

Recovery proof requirements, delay windows, notification channels, and escalation policy remain product/security decisions to finalize before implementation.

### 3.4.1 Approved and implemented C3 MVP boundary

The approved C3 implementation supports only recovery of a `suspended` account after a fresh OIDC authentication using an exact external identity that is already bound to that same internal user and remains in `active` identity lifecycle state.

- The flow uses a five-minute, single-use, browser-bound state/nonce/PKCE transaction and requires a recent `auth_time`.
- Account recovery changes only the internal account-security projection. The immutable external identity binding and external identity lifecycle state/history are not changed.
- A successful transition appends account-security and recovery audit records and creates a session-revocation outbox barrier in the same database transaction. All prior sessions must be revoked before fresh login.
- `disabled` accounts, revoked identities, unknown identities, active accounts, and all other ineligible cases are denied with a generic response.
- Email/phone matching, identity transfer, identity reactivation, account merging, and support-agent recovery remain prohibited.
- Full lost-account recovery is deferred: if no active linked identity remains, this MVP has no automatic recovery path.
- Verified notification infrastructure and a trusted-edge rate-limit policy are not yet implemented and are required before public rollout. The new OIDC callback URI also requires explicit allow-list configuration at the provider; no provider configuration was changed in C3.
- Implementation details and CI evidence: `docs/engineering/phase-c3-safe-account-recovery-implementation.md`.

## 4. Transaction, concurrency, and database requirements

- Use parameterized SQL and explicit transactions.
- Lock the internal user and relevant identity/lifecycle rows before evaluating mutable preconditions.
- Enforce uniqueness for the immutable `(issuer, subject)` binding and for the active lifecycle projection so concurrent requests cannot create duplicate active ownership.
- Consume link/recovery transactions atomically and exactly once.
- Treat duplicate callbacks and replay attempts as denied; do not make a failed callback reusable.
- Make audit insertion part of the same transaction as the lifecycle state change. If the audit write fails, the state change must roll back.
- Keep tenant RLS and tenant data access out of this identity workflow; identity operations must not accept a client-supplied tenant as authority.
- Define retention and privacy rules for revoked identity metadata and audit events before shipping.

## 5. BFF and session security

- Keep provider tokens server-side; never expose them to browser JavaScript.
- Require exact configured Origin on state-changing browser requests and synchronizer CSRF tokens.
- Bind every transaction to the browser and the initiating internal user; use fixed callback and post-operation destinations.
- Use short expiry, cryptographically random one-time values, and constant-time comparisons where applicable.
- Rotate session ID and CSRF token after successful linking. Revoke sessions after unlink, recovery, account disablement, or suspected compromise.
- Ensure revocation failures are visible to operations and do not silently report a successful security transition.
- Return generic user-facing errors for identity conflicts and avoid account enumeration.

## 6. Audit event model

Suggested event types:

- `external_identity.link_started`
- `external_identity.link_succeeded`
- `external_identity.link_denied`
- `external_identity.unlink_succeeded`
- `external_identity.unlink_denied`
- `external_identity.recovery_started`
- `external_identity.recovery_succeeded`
- `external_identity.recovery_denied`
- `external_identity.reactivated`
- `user_sessions.revoked_for_identity_change`

Minimum metadata: event ID, timestamp, actor internal user ID (or system actor), target internal user ID, opaque identity-binding reference, outcome, reason category, correlation ID, and security-relevant source metadata with privacy minimization.

Never record access/refresh/ID tokens, authorization codes, client secrets, session cookies, raw OIDC claims, or full provider responses.

## 7. Required test coverage and acceptance criteria

The implementation is not acceptable until automated tests cover:

1. Linking succeeds only after recent reauthentication and a separately verified new provider identity.
2. Expired, replayed, wrong-purpose, wrong-browser, wrong-user, and CSRF-invalid transactions fail closed.
3. Issuer, audience, nonce, PKCE, redirect, and provider mismatch are rejected.
4. A binding owned by another user cannot be linked, reactivated, or disclosed.
5. Concurrent attempts produce exactly one valid binding and a deterministic safe conflict for the other attempt.
6. Same-user duplicate linking is safely idempotent.
7. Unlink is denied when it would remove the last approved sign-in/recovery path.
8. Unlink and recovery state changes are atomic with audit events.
9. Session revocation is verified for link/unlink/recovery and account security lifecycle hooks.
10. A revoked identity cannot authenticate; it cannot be claimed by a different user.
11. Disabled users cannot link, unlink, or recover through normal authenticated flows.
12. No test or implementation relies on email/phone matching or provider claims for tenant authorization.

## 8. Proposed delivery plan — separate approvals

### Phase A — lifecycle schema and policy foundation
- Finalize active/suspended/revoked semantics and recovery-method policy.
- Add lifecycle state/event persistence and constraints without changing the existing immutable binding semantics.
- Add read-only lifecycle lookup and migration/backfill validation.
- Add database and concurrency tests.

### Phase B — secure link and unlink workflows
- Add BFF endpoints and one-time transaction storage for link/unlink.
- Add step-up reauthentication, CSRF, replay protection, conflict handling, session rotation/revocation, and audit events.
- Add complete negative and concurrency test coverage.

### Phase C — recovery and account lifecycle integration
- Design and implement recovery only after its proof and notification policy is separately approved.
- Wire session revocation into account disablement, identity security events, credential reset, and compromise handling.
- Add operational alerts, recovery audit review, and runbooks.

Each phase requires explicit founder approval before code changes. Approval of this design document alone does not authorize implementation, migration execution, Keycloak configuration, deployment, merge, or release.

## 9. Explicitly out of scope

- Email/phone-based identity matching or automatic account merging.
- Automatic account creation from an unknown OIDC identity.
- Tenant membership, role, branch, or permission changes.
- Provider-specific social login beyond the existing generic OIDC contract.
- Support-agent identity reassignment or manual database repair.
- Production deployment, public exposure, persistent Keycloak staging, merge, or release.

## 10. Open decisions for founder approval

1. Is a 5-minute step-up reauthentication window acceptable for link and unlink?
2. Should linking revoke all other sessions (recommended conservative default) or only rotate the current session?
3. Which recovery methods are permitted for the MVP? The recommended safest initial scope is to defer self-service recovery and support only an already active sign-in method; full lost-account recovery remains a later separately approved phase.
4. Should an identity be eligible for reactivation only for its original internal user? This design recommends yes, never reassignment.
5. What user notification channels are available and verified for identity lifecycle changes?

**Current implementation status:** Phases A and B and account-security phases C1–C3 have implementation records on the working branch. C4 final security audit/closure remains in progress. No Keycloak configuration, staging/production deployment, merge, or release has been performed.
