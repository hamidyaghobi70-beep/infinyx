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
