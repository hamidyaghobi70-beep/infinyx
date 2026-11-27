# Keycloak Staging Integration — Implementation Design

- **Status:** Draft for founder review
- **Related ADR:** ADR-0011 — Identity Provider Selection and Staging-First Adoption
- **Decision owner:** INFINYX founder
- **Scope:** Non-production staging design only
- **Implementation status:** Not implemented; this document does not authorize deployment or code changes

## 1. Purpose

Define a bounded, testable design for evaluating self-hosted Keycloak as the INFINYX identity provider in a non-production staging environment. The design preserves the provider-neutral authentication boundary and the existing INFINYX ownership of internal users, tenants, memberships, roles, branch access, and authorization.

The objective is to gather evidence about OIDC integration, identity mapping, session behavior, email/phone verification feasibility, operational effort, and recovery before making production decisions.

## 2. Scope boundaries

### In scope for a separately approved staging implementation

- A private, non-production Keycloak deployment.
- Dedicated staging PostgreSQL persistence for Keycloak.
- A staging OIDC client using Authorization Code Flow with PKCE for public clients.
- Server-side token validation and external identity mapping to internal INFINYX user IDs.
- A minimal staging integration against the existing provider-neutral authentication boundary, subject to code review.
- Test-only email/phone verification prototypes using replaceable adapters or documented Keycloak-supported mechanisms.
- Observability, rate limiting, backup/restore exercise, and failure-mode tests.
- Documentation of evidence and operational effort.

### Out of scope

- Production deployment, public production exposure, production credentials, or live user migration.
- Production high availability, production service-level objectives, and final capacity sizing.
- Selection of SMS/email delivery vendors.
- Sending real messages to users without a separately approved provider and controlled test plan.
- Custom Keycloak extensions/authenticators without a separate design, maintenance owner, and explicit approval.
- Changes to tenant membership, role, branch authorization, or RLS policy.
- Merge, release, or deployment to production.

## 3. Logical architecture

    Staging Browser / Test Client
              |
              | OIDC Authorization Code + PKCE
              v
       Keycloak (staging)
              |
              | signed OIDC tokens / discovery / JWKS
              v
    INFINYX Authentication Boundary
              |
              +--> issuer + subject identity mapping
              |
              +--> internal user resolution
              |
              v
    INFINYX Authorization / Tenant DAL
              |
              +--> current DB-backed membership
              +--> role and lifecycle checks
              +--> branch assignment checks
              +--> tenant-scoped transaction and RLS

Keycloak is the authentication authority only. INFINYX authorization must be evaluated from current database-backed state for every protected operation. A valid token, tenant identifier, role claim, or branch identifier supplied by a client is not sufficient authorization evidence.

## 4. Environment and deployment shape

For staging, prefer a reproducible container-based deployment behind a TLS-terminating reverse proxy or ingress. The exact runtime platform is intentionally undecided until the team's hosting constraints are reviewed.

Minimum components:

1. Keycloak staging service, with a pinned and reviewed version.
2. Dedicated PostgreSQL database and least-privilege database role for Keycloak.
3. TLS endpoint and restricted administrative access.
4. Secret injection from an approved secret-management mechanism; no secrets committed to Git.
5. Private staging OIDC client configuration.
6. Monitoring and centralized logs with credentials, tokens, OTPs, and unnecessary personal data excluded.
7. Encrypted backup and a documented restore exercise.

Development, staging, and production must have strict environment separation. Do not create a realm per INFINYX tenant. Tenant boundaries remain in INFINYX.

## 5. OIDC client and token validation

- Use Authorization Code Flow with PKCE for browser and native public clients.
- Browser/mobile clients are public clients and must not contain client secrets.
- Use confidential clients only for trusted server-to-server components, with secrets held outside source control.
- Configure exact redirect URI and post-logout redirect URI allowlists; avoid broad wildcards.
- Validate signature against trusted issuer metadata/JWKS, exact issuer, intended audience, expiry, not-before, and relevant authentication context.
- Define accepted signing algorithms explicitly; reject the none algorithm and unexpected algorithms.
- Handle JWKS rotation safely and fail closed when token authenticity cannot be established.
- Do not accept tokens issued by development or production realms in staging.
- Token lifetimes, refresh-token rotation/reuse handling, session idle/max settings, and logout/revocation semantics remain configuration decisions for the staging test plan; record chosen values before testing rather than silently relying on defaults.

## 6. External identity mapping

Use a provider-neutral identity record conceptually keyed by:

- issuer — exact trusted OIDC issuer URI;
- subject — exact OIDC sub value;
- internal_user_id — stable INFINYX user identifier.

Enforce uniqueness on (issuer, subject). Do not use email or phone as the primary external identity key, and do not assume subject equals the internal user ID.

Mapping behavior:

1. Validate the token before identity lookup.
2. Resolve (issuer, subject) to an existing internal user.
3. If no mapping exists, do not silently create or link an account in the first staging iteration. Use an explicitly designed, audited provisioning flow or return a safe, generic denial.
4. Treat email and phone as attributes. Trust their verification status only when it is produced by a configured, validated flow and mapped from a documented claim contract.
5. Account linking requires an authenticated linking ceremony and fresh proof of control of both identities. Similar email/phone values are not proof.
6. Record security-relevant linking and unlinking events without storing tokens, OTPs, or secrets.

The exact schema and repository changes, if needed, require a separate implementation proposal and approval.

## 7. Authentication and authorization request lifecycle

1. Client starts OIDC Authorization Code + PKCE with the staging Keycloak issuer.
2. Keycloak authenticates the user and returns an authorization code.
3. Client exchanges the code according to the OIDC client type and receives tokens.
4. The trusted INFINYX server validates the token and resolves (issuer, subject).
5. INFINYX establishes its own authenticated principal using the stable internal user ID.
6. For a tenant operation, INFINYX starts the tenant-scoped database transaction, verifies current active membership and role from the database, checks branch assignment where applicable, and performs the protected operation in that same transaction.
7. Missing identity mapping, invalid token, inactive membership, authorization mismatch, or provider uncertainty fails closed.
8. Errors returned to clients remain generic and must not reveal whether another user's account or tenant exists.

Do not use a Keycloak tenant claim or Keycloak group/role as a substitute for INFINYX membership and authorization.

## 8. Email and phone verification evaluation

ADR-0011 requires both email and phone as product login methods, but it does not select delivery vendors or guarantee native support for the exact OTP experience.

Staging evaluation must separately test:

### Email

- Whether built-in Keycloak flows meet the desired Email OTP experience.
- Whether a custom authenticator is required.
- Message template localization and Persian/RTL experience.
- Expiration, replay prevention, throttling, and abuse monitoring.
- Safe handling of mail delivery failures.

### Phone

- Whether a supported, maintained authenticator or adapter is required for SMS OTP.
- Adapter contract independent of any single SMS vendor.
- OTP expiration, one-time use, throttling, resend limits, and abuse detection.
- Regional delivery capability, sender requirements, reliability, and legal/operational constraints before any vendor selection.
- No live external delivery until a vendor and test plan are explicitly approved.

Never log OTP values, credentials, full tokens, or delivery secrets. Do not use email/phone equality alone to link accounts.

## 9. Security and privacy controls

- Keep Keycloak administration private and restrict it to authorized operators.
- Separate end-user clients from administrative service accounts.
- Apply least privilege to Keycloak's PostgreSQL role and any INFINYX integration credentials.
- Require TLS for all staging endpoints and secure cookies for browser sessions.
- Store secrets outside Git; define rotation and revocation procedures.
- Rate-limit login, OTP request, resend, and verification attempts.
- Avoid account enumeration through response text and timing where practical.
- Log security events with correlation IDs while excluding credentials, OTPs, tokens, and unnecessary personal data.
- Keep tenant RLS and DAL checks. Existing custom tenant GUC RLS is defense-in-depth, not protection against arbitrary SQL execution; parameterized SQL and independent security review remain required.
- Define data retention and deletion for test identities; use synthetic test accounts wherever possible.

## 10. Staging acceptance criteria

Staging is not considered validated until evidence is recorded for all applicable criteria:

1. OIDC discovery and signing-key retrieval use the configured staging issuer only.
2. Valid tokens pass; wrong issuer, wrong audience, invalid signature, expired, not-yet-valid, and malformed tokens are rejected.
3. (issuer, subject) maps deterministically to one internal user; unknown identities fail closed unless an approved provisioning flow exists.
4. Browser/public client uses PKCE and contains no client secret.
5. Redirect URI validation rejects unregistered destinations.
6. Logout and session expiration behavior are documented and tested.
7. Keycloak outage and database outage fail closed without granting access.
8. An authenticated user without current active tenant membership cannot access tenant data.
9. Suspended and removed memberships remain denied even if a valid identity-provider token exists.
10. Cross-tenant and unassigned-branch access remains denied by INFINYX authorization and database controls.
11. Email and phone verification feasibility, adapter behavior, abuse controls, and delivery limitations are documented.
12. No credential, OTP, access token, refresh token, or client secret appears in logs.
13. Encrypted backup restore is exercised and results recorded.
14. Upgrade/rollback procedure is rehearsed in staging.
15. Monitoring and operator runbooks cover service health, authentication errors, suspicious OTP activity, and incident escalation.

Any failed criterion blocks a production recommendation until resolved or explicitly accepted through a separate risk decision.

## 11. Evidence to capture

Record:
- Keycloak version and deployment configuration (excluding secrets);
- OIDC client settings and claim contract;
- token validation test results;
- identity mapping test results;
- email/phone flow behavior and extension dependencies;
- security and tenant-isolation test results;
- backup/restore and upgrade/rollback results;
- resource use, latency, availability observations, and operational effort;
- open risks, mitigations, and decisions needed before production.

## 12. Open decisions before implementation

The following must be resolved in the implementation plan or staging approval:
- staging hosting platform and network boundary;
- supported Keycloak version and upgrade policy;
- exact OIDC client topology (server-side web/BFF versus direct public client);
- claim contract and whether a new external-identity mapping table is required;
- provisioning and account-recovery flows;
- email delivery mechanism and whether Email OTP requires a custom authenticator;
- SMS adapter interface and test strategy;
- secret manager and backup destination;
- token/session settings and logout semantics;
- staging test identities and data-retention policy.

## 13. Governance and authorization

This document is a design proposal only. The founder approved the Keycloak provider selection and staging-first strategy in ADR-0011, but has not yet authorized staging deployment or implementation code changes.

All subsequent work must remain on feat/adr-platform-foundation. Keep main unchanged. No merge, release, production deployment, public exposure, production credentials, or live message delivery is authorized by this document.


---

# Founder-approved design refinement — 2026-11-27

- **Status:** Incorporated into the design; implementation remains unauthorized.
- **Founder decisions:** Web uses a server-side Backend-for-Frontend (BFF). Future native mobile uses OIDC Authorization Code Flow with PKCE S256. Authenticated identity is independent from tenant context; INFINYX database state remains authoritative for tenant selection, membership, roles, and branch access.

This addendum supersedes any conflicting statements in Sections 3, 5, 7, 12, and 13 above. The original sections remain as historical context for the initial proposal.

## A. Updated logical architecture

    Browser
       | HTTPS; opaque Secure/HttpOnly session cookie
       v
    INFINYX Web BFF (OIDC confidential client)
       | server-side authorization-code exchange
       | server-side token/session handling
       v
    Keycloak (staging issuer)
       | OIDC metadata / JWKS / signed tokens
       v
    INFINYX Authentication Boundary
       | validate token; resolve (issuer, subject)
       | map to stable internal user ID
       v
    INFINYX Authenticated Identity
       | internal user ID; no tenant claim/context
       v
    Tenant Selection + Authorization / Tenant DAL
       | current DB-backed membership and lifecycle
       | role and branch assignment checks
       | tenant-scoped transaction and RLS

Authentication establishes who the user is. It does not establish which tenant the user may access. A user may belong to multiple tenants. A selected tenant identifier is only a request selector and never proof of access. For every protected operation, INFINYX must verify current active membership, role, and applicable branch assignment from the database within the same transaction as the protected operation. Keycloak tenant, group, and role claims are not authoritative for INFINYX authorization.

## B. Web BFF — approved topology

The browser is not an OIDC token holder. The BFF is the confidential OIDC client and performs the authorization-code exchange server-side.

- Use Authorization Code Flow with PKCE S256, including for the confidential BFF.
- Keep access and refresh tokens server-side. Never expose them to browser JavaScript or store them in localStorage/sessionStorage.
- Give the browser only an opaque session identifier in a cookie configured Secure, HttpOnly, and with an appropriate SameSite policy.
- Bind the server-side session to the authenticated internal identity and define explicit idle and absolute expiry.
- Protect state-changing BFF requests against CSRF using a documented token strategy and origin checks.
- Rotate the session identifier after authentication and privilege changes to prevent session fixation.
- Bind one-time state, nonce, and PKCE verifier to the initiating browser session. Validate state on callback and nonce in the OIDC login response.
- Use exact redirect and post-logout redirect allowlists; no broad wildcards or open redirects.
- Define server-side refresh, revocation, logout, session invalidation, and suspected-compromise behavior before staging tests.
- Do not log cookies, authorization codes, tokens, client secrets, or CSRF tokens.
- BFF endpoints must be application-specific, not a generic token proxy. Each endpoint independently performs INFINYX authorization.

Future native mobile should use Authorization Code + PKCE S256 as a public client with no embedded client secret, system-browser authentication, and platform secure credential storage. Mobile implementation is outside this staging design approval and needs its own implementation plan.

## C. OIDC discovery, JWKS, and access-token validation

- Pin the expected issuer URI in trusted server configuration for each environment. Never derive the issuer or discovery URL from a token or user input.
- Fetch discovery metadata only from that configured issuer over TLS and require an exact metadata issuer match.
- Fetch keys only from the validated jwks_uri in that metadata.
- Explicitly allowlist signing algorithms (initially RS256 only if selected realm configuration supports it); reject none, unexpected algorithms, and algorithm/key-type mismatches.
- Validate signature, exact issuer, API-specific audience, expiry, not-before, subject, and required token-use/type constraints.
- APIs accept access tokens only, not ID tokens. Define the API audience and, where applicable, expected authorized-party/client identifier (azp) explicitly.
- Require kid when multiple keys may be published. On unknown kid, perform at most a bounded refresh from the pinned JWKS endpoint; if unresolved, fail closed.
- Support safe key rotation and bounded cache lifetimes. Never follow token-supplied jku, x5u, or any other key-discovery URL.
- Define clock-skew tolerance. Malformed, unsigned, expired, not-yet-valid, wrong-issuer, wrong-audience, wrong-token-type, or unsupported tokens are rejected.
- Metadata/JWKS outage or inability to establish token authenticity fails closed. Staging must not accept development or production realm tokens.

The existing static-PEM verifier is not a completed Keycloak integration. The implementation proposal must introduce a provider-neutral OIDC/JWKS verification boundary with pinned issuer/discovery configuration, algorithm allowlisting, bounded JWKS caching/refresh, and explicit failure behavior.

## D. Identity mapping and account linking

Use a provider-neutral identity record keyed by exact trusted issuer plus exact OIDC subject, mapped to a stable internal INFINYX user ID. Enforce database uniqueness on (issuer, subject). Email and phone are attributes, not primary identity keys; matching values never prove account ownership.

- Validate the token before identity lookup.
- Resolve the verified (issuer, subject) to an existing internal user.
- Unknown identities fail closed unless a separately approved, audited provisioning flow exists. Do not silently create or link accounts.
- Account linking requires an already authenticated target INFINYX account, fresh proof of control of the new identity, and explicit confirmation.
- Linking/unlinking must be transactional and concurrency-safe: enforce uniqueness, lock or serialize affected identity/user records, re-check mapping and authorization after locks, and make retries idempotent.
- An identity already linked to another internal user must never be reassigned implicitly. Conflicts fail closed and produce a security audit event.
- Define recovery and unlink safeguards so a user cannot accidentally lose their only usable sign-in method.
- Never store tokens, OTPs, or secrets in audit events.

The external identity mapping schema, provisioning flow, and account-linking repositories require a separate implementation proposal and approval.

## E. Updated authentication and tenant authorization lifecycle

1. Browser starts login through the INFINYX BFF.
2. BFF creates one-time state, nonce, and PKCE verifier/challenge and binds them to the initiating browser session.
3. Keycloak authenticates the user and redirects the authorization code only to the exact registered BFF callback.
4. BFF validates state, exchanges the code server-side using the PKCE verifier and confidential-client authentication, and validates the OIDC response, including nonce.
5. INFINYX resolves verified (issuer, subject) to an existing internal user. Unknown identities fail closed unless a separately approved provisioning flow exists.
6. BFF rotates the session identifier and establishes an opaque server-side application session bound to the internal user identity.
7. For a tenant operation, the user selects a tenant (or supplies a previously selected tenant as a selector). INFINYX begins a tenant-scoped database transaction and checks current active membership and role from the database. Branch assignment is checked where applicable. Authorization and protected data operation use the same transaction.
8. Client-supplied tenant identifiers never grant access. Missing, suspended, or removed membership and missing branch assignment deny the operation.
9. Logout invalidates the INFINYX server-side session and follows documented Keycloak end-session/revocation behavior. Invalid or expired sessions cannot authorize requests.
10. Provider, mapping, or authorization uncertainty fails closed. Client errors remain generic and do not reveal whether another user's account or tenant exists.

## F. Additional security and privacy requirements

- Protect BFF endpoints against CSRF, session fixation, open redirects, and cross-origin state-changing requests.
- Rate-limit login, callback, OTP request/resend, and verification attempts.
- Define session invalidation for user disablement, credential reset, identity unlinking, and suspected compromise.
- Log correlation IDs and security events, but never credentials, OTPs, access/refresh tokens, session cookies, authorization codes, or CSRF tokens.
- Keep tenant RLS and DAL checks. Existing custom tenant GUC RLS is defense-in-depth, not protection against arbitrary SQL execution; parameterized SQL and independent security review remain required.
- Tenant context must be resolved separately from authenticated identity and checked from current database state in the same transaction as the protected operation.

## G. Expanded staging acceptance criteria

Staging is not validated until evidence exists for all applicable criteria:

1. Discovery metadata issuer exactly matches the configured issuer; discovery and JWKS use only trusted configured endpoints.
2. Valid access tokens pass; wrong issuer/audience, ID tokens presented to APIs, invalid signature, unsupported algorithm, unknown kid after bounded refresh, expired, not-yet-valid, malformed, and otherwise invalid tokens are rejected.
3. JWKS rotation works without accepting untrusted keys; JWKS/network failures fail closed.
4. BFF login validates state, nonce, PKCE S256, exact callback URI, and confidential-client authentication.
5. Browser receives no access/refresh token; cookie flags, session rotation, CSRF defenses, idle/absolute expiry, and logout invalidation are tested.
6. Open redirects, login CSRF, session fixation, and cross-origin state-changing requests are rejected.
7. (issuer, subject) maps deterministically to one internal user; unknown identities fail closed unless approved provisioning exists.
8. Concurrent account-link attempts, duplicate mappings, linking an identity already owned by another user, retries, unlinking, and recovery safeguards are tested.
9. A valid identity-provider session without current active membership cannot access tenant data.
10. A multi-tenant user can select only tenants for which current database-backed membership exists; client tenant identifiers never grant access.
11. Suspended and removed memberships remain denied even with a valid identity-provider token.
12. Cross-tenant and unassigned-branch access remains denied by INFINYX authorization and database controls.
13. Email and phone verification feasibility, adapter behavior, abuse controls, and delivery limitations are documented.
14. No credential, OTP, access/refresh token, session cookie, authorization code, CSRF token, or client secret appears in logs.
15. Keycloak, JWKS, and database outages fail closed without granting access.
16. Encrypted backup restore and upgrade/rollback are exercised, including extension compatibility where applicable.
17. Monitoring/runbooks cover service health, authentication errors, suspicious OTP activity, session invalidation, and incident escalation.
18. Future-mobile flow is documented as Authorization Code + PKCE S256 with no embedded client secret; it is not claimed as implemented or validated by web BFF tests.

Any failed criterion blocks a production recommendation unless addressed or explicitly accepted through a separate risk decision.

## H. Repository compatibility gaps

The current repository authentication code must be reconciled before implementation is proposed:

- The existing authenticated-principal model includes a tenant identifier, and the current verifier expects a static PEM key. Neither implements the approved separation of identity from tenant context or trusted OIDC discovery/JWKS rotation.
- Replace tenant-bearing authentication claims as an authorization source with verified external identity (issuer, subject) mapped to a stable internal user ID.
- Resolve tenant context separately for each operation from a tenant selector plus current database-backed membership and role checks, within the same tenant-scoped transaction as the protected operation.
- Review all callers that assume a principal always contains tenantId. Preserve the verified-principal trust boundary and fail-closed behavior; do not allow user-controlled objects to masquerade as authenticated identities.
- The exact external-identity schema, internal-user provisioning path, BFF session store, and migration strategy remain design items requiring a separate implementation proposal.

No code changes are included in this document revision.

## I. Decisions still required before an implementation proposal

- Staging hosting platform and network boundary.
- Supported Keycloak version and upgrade policy.
- BFF deployment boundary, server-side session store, CSRF mechanism, cookie policy, and logout/session invalidation behavior.
- OIDC client identifiers, API audience, token-use contract, accepted algorithms, JWKS cache policy, and clock-skew tolerance.
- External-identity mapping schema and internal-user provisioning/recovery flow.
- Account-linking/unlinking transaction and audit design.
- Email delivery mechanism and whether Email OTP requires a custom authenticator.
- SMS adapter interface and test strategy.
- Secret manager, backup destination, staging test identities, and data-retention policy.

## J. Governance and authorization

This revision records the founder's approval of two design choices: (1) web authentication uses a server-side BFF, while future native mobile uses OIDC Authorization Code + PKCE S256; (2) authenticated identity is independent from tenant context, and tenant selection, membership, role, and branch authorization remain authoritative in INFINYX's current database state.

This document remains a design proposal. Approval of these design refinements does not authorize code changes, Keycloak configuration, staging deployment, public exposure, production credentials, or live message delivery. A separate implementation scope and explicit founder approval are required before any code, infrastructure, or Keycloak configuration changes.

All subsequent work must remain on feat/adr-platform-foundation. Keep main unchanged. No merge, release, deployment, or live message delivery is authorized.
