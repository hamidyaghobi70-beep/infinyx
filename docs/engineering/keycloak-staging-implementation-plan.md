# Keycloak Staging Integration — Proposed Implementation Plan

- **Status:** Phases 1 and 2 implemented and CI verified; Phases 3–6 require separate founder approval
- **Related:** ADR-0011 and Keycloak Staging Integration Design
- **Branch:** feat/adr-platform-foundation
- **Environment:** Staging only, after separate infrastructure approval

## 1. Purpose and approved decisions

This plan records the approved architecture and bounded execution sequence. Phase 1 was explicitly authorized, implemented, and CI verified. This document does not authorize any additional phase, Keycloak configuration, infrastructure provisioning, deployment, live message delivery, merge, or release. Phases 1 and 2 have bounded code approval only; all later phases remain separately gated.

Accepted design decisions:
1. Keycloak Self-Hosted; staging-first.
2. Web login through a server-side BFF. Browser receives only an opaque Secure/HttpOnly session cookie, never OAuth tokens.
3. Future native mobile uses OIDC Authorization Code + PKCE S256 as a public client; mobile implementation is out of this scope.
4. Authenticated identity is independent from tenant context.
5. INFINYX remains authoritative for internal user IDs, tenant membership/lifecycle, roles, branch assignments, and business authorization.
6. Client-supplied tenant identifiers are selectors, never proof of access.
7. Work remains on feat/adr-platform-foundation; main remains unchanged; no merge, release, or production deployment.

## 2. Baseline compatibility findings (before Phase 1)

Review of the current branch source identifies these required changes:

- src/core/authenticated-principal.ts currently includes subject and tenantId; the verifier uses a static PEM key and requires a tenant_id claim.
- createPrincipalMemoryScope derives tenant scope from that principal.
- src/persistence/tenant-transaction.ts sets app.tenant_id from principal.tenantId.
- src/persistence/tenant-membership.ts uses principal.tenantId and principal.subject as tenant/user selectors.
- Invitation persistence uses the principal for actor identity, while invitation-token lookup independently resolves the invitation tenant; preserve this distinction.
- The current principal trust boundary uses a module-private WeakSet. Any replacement must continue rejecting arbitrary client-created objects.

These were baseline observations before Phase 1. The implemented state and remaining limitations are recorded in [Identity and Tenant Separation — Implementation Record](identity-tenant-separation-implementation.md). These observations are not a complete security audit.

## 3. Target security boundary

### Authenticated identity

Use a provider-neutral, server-trusted identity containing:
- stable internal userId;
- verified external identity provenance (issuer, subject), or a durable reference to it;
- only necessary validated authentication/session metadata.

It must not contain tenantId, tenant role, branch ID, or provider group/role as authorization evidence. Only trusted authentication adapters may create this identity. Preserve a non-forgeable runtime trust boundary. Map verified (issuer, subject) to an existing internal user before issuing an authenticated application identity. Never assume OIDC sub equals internal userId; unknown identities fail closed unless provisioning is separately approved.

### Tenant context

Treat the requested tenant as an untrusted selector. A protected tenant operation must:
1. accept a trusted identity and a syntactically valid tenant selector;
2. begin a database transaction and set transaction-local RLS context from that selector;
3. verify current active membership for (tenant_id, user_id) before exposing the transaction to repository work;
4. load role and lifecycle state from the database;
5. check branch assignment where applicable;
6. perform authorization and protected data access in the same transaction;
7. fail closed on missing, suspended, removed, ambiguous, or unverifiable membership.

The transaction boundary should prevent repository work before membership authorization succeeds. This remains defense-in-depth, not protection against arbitrary SQL execution; parameterized SQL, trusted query text, least privilege, RLS, and independent security review remain required.

A user may belong to multiple tenants. Authentication does not select a tenant. Each operation independently verifies membership for its selected tenant; switching tenants cannot reuse a prior authorization result.

## 4. Implementation phases

### Phase 0 — Baseline inventory

- Enumerate all callers of AuthenticatedPrincipal, principal.tenantId, principal.subject, createPrincipalMemoryScope, and withTenantTransaction.
- Inventory middleware, repositories, tests, invitation paths, and all code trusting tenant/role/branch/email/phone claims.
- Produce a compatibility matrix before changing types.

**Exit criteria:** all call sites accounted for; no unexplained principal/tenant-context consumer; no production credentials or real user data required.

### Phase 1 — Identity/tenant separation — Implemented

- Replace the tenant-bearing principal with a trusted identity based on internal userId and verified identity provenance.
- Refactor withTenantTransaction to accept identity plus separate tenant selector and perform mandatory active-membership authorization before exposing its callback.
- Refactor membership helpers to use identity.userId and the selected tenant context.
- Refactor memory scoping so tenant/business/project scope is only created after valid membership context; keep personal memory distinct.
- Refactor invitation actor attribution to use internal user identity. Invitation tenant comes from an authorized tenant operation or token lookup, never an IdP tenant claim.
- Preserve generic errors, parameterized SQL, transaction poisoning, rollback safety, and non-forgeable identity trust.

Avoid long-lived dual-mode authentication accepting both old tenant-bearing and new tenant-independent principals. Make the change atomically across callers/tests. No fallback to old JWT tenant claims.

**Exit criteria:** no-membership user denied even with a valid tenant selector; multi-tenant user restricted to separately granted memberships; suspended/removed denied; tenant/role claims grant no access; RLS integration tests pass; no repository callback runs before membership check. Verified by CI [#45935238195](https://github.com/hamidyaghobi70-beep/infinyx/actions/runs/45935238195): 11 test files and 99 tests passed, TypeScript typecheck passed, migrations and syntax checks passed, and npm audit reported 0 vulnerabilities. See the [implementation record](identity-tenant-separation-implementation.md).

### Phase 2 — Provider-neutral OIDC verification — Implemented

- Pin trusted issuer and expected API audience per environment.
- Fetch discovery metadata only from configured issuer over TLS; require exact issuer match.
- Fetch JWKS only from validated metadata.
- Allowlist algorithms explicitly; configure RS256 only if selected realm supports it.
- Validate signature, issuer, API audience, token use/type, expiry, not-before, subject, and authorized-party/client constraints where needed.
- Reject ID tokens at API access-token boundaries.
- Add bounded JWKS caching/refresh and safe key rotation; unknown kid fails closed after bounded refresh.
- Never follow token-supplied jku/x5u.
- Keep provider/network errors generic.

Keep BFF login-response validation (state, nonce, PKCE, confidential-client authentication) distinct from API access-token validation and BFF session authentication. Do not build a generic token proxy.

**Exit criteria:** deterministic tests for wrong issuer/audience, ID token used as API token, bad signature, unsupported algorithm, missing/unknown kid, rotation, expiry/nbf, malformed claims, metadata/JWKS outage, and clock skew. No live public Keycloak dependency in unit tests.

### Phase 3 — External identity mapping

- Propose a provider-neutral mapping table for issuer, subject, internal_user_id, timestamps/status, and justified audit metadata.
- Enforce uniqueness on (issuer, subject) and referential integrity to internal users.
- Define whether one internal user may have multiple external identities and safe unlink/recovery rules.
- Unknown identities fail closed until a separately approved provisioning flow exists.
- Account linking/unlinking requires authenticated confirmation, fresh proof of control, transactional concurrency safety, idempotency, and audit.
- Never auto-link by email/phone equality.

**Exit criteria:** duplicate/concurrent mapping cannot link one external identity to two users; unknown identities denied; already-linked identity cannot be reassigned; audit contains no tokens, OTPs, credentials, or unnecessary personal data.

### Phase 4 — Web BFF and server-side sessions (implemented; CI verified)

- Define application-specific BFF routes and use server-side Authorization Code + PKCE S256 with confidential-client authentication.
- Bind state, nonce, and PKCE verifier to initiating browser session; validate callback state and OIDC nonce.
- Exact redirect allowlists; reject open redirects.
- Keep provider tokens server-side; browser receives only opaque Secure, HttpOnly cookie with appropriate SameSite.
- Select a server-side session store; do not assume process memory works for multi-instance deployment.
- Rotate session ID after login and privilege changes.
- Protect state-changing endpoints against CSRF and enforce origin checks.
- Define idle/absolute expiry, refresh, revocation, logout, and invalidation on user disablement, credential reset, identity unlinking, and suspected compromise.
- Never log tokens, cookies, authorization codes, or CSRF tokens.

**Implementation status:** Implemented on feat/adr-platform-foundation. The Node.js built-in HTTP BFF, OIDC Authorization Code + PKCE flow, encrypted PostgreSQL login transactions and sessions, CSRF checks, cookie handling, token refresh serialization, and local logout are recorded in docs/engineering/web-bff-session-implementation.md. Automated tests cover callback replay, previous-session rotation, fixed post-login redirect, cross-origin CSRF rejection, and fail-closed identity mapping. CI run 45941140918 passed (19 test files, 132 tests, typecheck, production build, migration checks, and npm audit with zero vulnerabilities).

**Remaining limitations before staging/production:** no live Keycloak realm/client, no login UI, no business API proxy routes or tenant-selection UI, no provider end-session redirect, no dedicated web-auth audit-event table, no automated hooks from user disablement/identity unlink to revokeAllForUser, and no session-encryption-key rotation runbook. The session itself contains no tenant authorization; future tenant operations must continue to re-check live INFINYX membership and branch permissions.

### Phase 5 — Staging Keycloak deployment

Requires separate infrastructure approval after Phases 0–4 are reviewed.

If approved:
- pin supported Keycloak version;
- define hosting/network boundary, TLS ingress, restricted administration, dedicated Keycloak PostgreSQL database/role, secrets, and encrypted backups;
- configure isolated staging realm and BFF client with exact callback/logout URLs and explicit audience/token contract;
- use synthetic test identities only;
- use local email/SMS sinks or separately approved test adapters; no live user delivery;
- configure monitoring, restore exercise, and upgrade/rollback runbook.

**Exit criteria:** staging private and isolated; no production credentials or real-user migration; backup/restore and upgrade/rollback evidenced; revised design acceptance criteria met; independent security review findings resolved or explicitly accepted before any production proposal.

### Phase 6 — Evidence and recommendation

Produce test/security evidence, operational effort and resource observations, failure-mode results, open risks/mitigations, and a proceed/revise/stop recommendation. Any production architecture and authorization proposal is separate.

## 5. Cross-cutting tests

- Trusted identity creation and rejection of forged objects.
- PostgreSQL tests for active/suspended/removed membership, multiple tenants per user, cross-tenant read/write denial, branch assignment denial, transaction cleanup, and concurrent membership changes.
- Invitation regression tests for creation, acceptance, revocation, token lookup, and actor attribution.
- Memory scope tests for personal vs tenant/business/project boundaries.
- OIDC tests for issuer/audience/token type, signature/algorithm, key rotation, time claims, discovery/JWKS failures, malformed inputs.
- BFF tests for state, nonce, PKCE, redirect allowlists, CSRF, fixation, cookie flags, expiry, logout, refresh, and replay.
- Account-linking tests for uniqueness, races, retries, audit atomicity, and recovery.
- No secrets in logs/audit; all SQL parameterized; least privilege and fail-closed behavior preserved.
- Staging success must not be described as production readiness.

## 6. Non-goals

No production deployment/public exposure/HA/production credentials; no real-user migration; no live email/SMS delivery or vendor selection; no custom Keycloak extensions without separate approval; no mobile implementation; no merge/release/deployment; no changes to main.

## 7. Decisions for remaining phases

Resolved by the implemented Phase 1:
1. **Internal identity:** canonical internal identity is `users.id` (UUID). User lifecycle/profile fields remain a later decision.
2. **Tenant transaction boundary:** mandatory active-membership authorization before repository callbacks is implemented.
3. **Memory scope:** personal scope uses internal user ID; tenant scope requires a live authorized transaction. Business/project-specific scopes remain deferred until their resource authorization boundaries exist.
4. **External identities:** one internal user may have multiple external identities; each exact `(issuer, subject)` pair maps to at most one internal user. Unlink and recovery workflows remain deferred.
5. **Unknown identities:** fail closed. Invitation acceptance requires an already mapped internal user; automatic account provisioning and email/phone-based linking are not enabled.

Still required before later phases:
6. **Resolved:** PostgreSQL is the server-side BFF session store. Session IDs and login-state values are hashed at rest; OAuth token bundles and pending OIDC PKCE/nonce data are AES-256-GCM encrypted. Refresh is serialized by a row lock. Database/session-store errors fail closed. Dedicated staging backup, key rotation, and operational recovery procedures remain to be designed.
7. Define API audience, token type/use, accepted algorithms, authorized-party/client expectations, and clock-skew tolerance.
8. Select hosting/network boundary, secret manager, and backup destination before infrastructure work.
9. Decide local-only email/SMS test sinks versus a separately approved non-production delivery provider and controlled recipients.

## 8. Separate approval gates

- **A — Design:** approve the target identity/tenant contract and resolve Section 7. No code or infrastructure changes.
- **B — Code:** Phases 1–4 have implementation records and CI evidence on the feature branch. Phase 4 implementation was explicitly approved and is recorded separately. No Keycloak deployment/configuration and no live delivery.
- **C — Staging infrastructure:** separately authorize Phase 5 after an explicit hosting, secrets, network, database, and test-data plan.
- **D — Production recommendation:** review Phase 6 evidence. Production deployment, merge, and release still require separate explicit authorization.

No phase may begin without its corresponding explicit approval.

## 9. Governance

Phases 1–4 implementation is recorded separately. Phase 5 staging infrastructure remains gated by explicit approval. All work remains on feat/adr-platform-foundation; main remains unchanged. No merge, release, production deployment, public exposure, production credentials, or live message delivery is authorized.
