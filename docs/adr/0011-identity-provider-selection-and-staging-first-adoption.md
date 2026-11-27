# ADR-0011: Identity Provider Selection and Staging-First Adoption

- **Status:** Accepted — provider selection and adoption strategy approved; implementation not yet authorized
- **Decision date:** 2026-11-27
- **Decision owner:** INFINYX founder
- **Related decisions:** ADR-0001, ADR-0003, ADR-0005, ADR-0007, ADR-0009, ADR-0010

## 1. Context

INFINYX requires a provider-neutral authentication boundary while retaining ownership of its multi-tenant business model, memberships, roles, branch access, and authorization rules. The founder's selected constraints are:

- Infrastructure preference: self-managed.
- Login methods: both email and phone.
- Primary priority: independence from an external identity SaaS.
- Operational capability: the team can operate identity infrastructure.
- Adoption strategy: establish and validate a staging environment first; finalize production topology after staging evidence is available.

The identity provider must not become the source of truth for INFINYX tenant membership or business authorization. Authentication success alone must never grant access to a tenant or branch.

## 2. Accepted decision

### 2.1 Provider and hosting

1. Select **Keycloak** as INFINYX's identity provider.
2. Operate Keycloak as a **self-hosted** service under the team's operational control.
3. Integrate through standard **OpenID Connect (OIDC)** protocols and keep the INFINYX integration boundary provider-neutral so a future provider change does not require redesigning tenant authorization.
4. Use separate Keycloak realms or equivalent strict environment isolation for development, staging, and production. Do not create a realm per tenant/business; tenant isolation remains an INFINYX domain responsibility.
5. Begin with a staging-first adoption. Production topology, availability targets, and high-availability design are finalized only after staging validation and a separate production-readiness review.

### 2.2 Responsibility boundary

Keycloak is authoritative for authentication and identity-provider session functions, including:
- authenticating a user;
- issuing and refreshing provider tokens;
- provider-managed session controls and supported MFA capabilities;
- provider-side identity verification signals, where configured and trustworthy.

INFINYX remains authoritative for:
- stable internal user identifiers;
- mapping external identities to internal users;
- tenant records and tenant membership lifecycle;
- roles and permissions (owner, admin, manager, editor, viewer);
- branch assignments and branch visibility;
- authorization decisions for every business operation;
- tenant-scoped data access, RLS, and Data Access Layer enforcement;
- account-linking policy and its audit trail.

Provider role/group claims must not independently authorize INFINYX tenant or branch access. INFINYX must verify current database-backed membership and authorization in the same tenant-scoped transaction as the protected operation.

### 2.3 External identity mapping

1. Map an external identity using the pair **(issuer, subject)** to a stable internal INFINYX user ID.
2. Do not assume that an OIDC subject value is the internal INFINYX user ID.
3. Enforce issuer and audience validation, signature verification using trusted provider metadata/keys, and token time/claim validation.
4. Treat email and phone claims as identity attributes, not proof of ownership unless they carry a trusted, validated verification status from the configured authentication flow.
5. Account linking must require proof of control of both identities and an authenticated linking flow. Matching email addresses or phone numbers alone must never trigger automatic account merging.
6. Provider unavailability or invalid/unverifiable identity data must fail closed for authentication-dependent operations.

### 2.4 Login methods

1. The product login experience must support both email and phone as intended identity methods.
2. Email and phone verification flows must be implemented through supported Keycloak capabilities and/or separately reviewed adapters/authenticators.
3. SMS OTP delivery must use a replaceable SMS adapter. No SMS vendor is selected by this ADR.
4. Email OTP behavior must be validated against the required user experience; if a custom authenticator or extension is needed, it requires a separately reviewed design and maintenance plan.
5. Do not assume that SMS OTP, email OTP, or delivery to any specific country—including Iran—is available out of the box or supported by a chosen vendor. Provider capability, regional delivery, abuse controls, and legal/operational constraints must be verified before selecting a delivery provider.
6. Apply rate limits, expiry, replay prevention, abuse monitoring, and secret minimization to OTP flows. OTPs and credentials must never be logged.

### 2.5 Client and protocol security

1. Use OIDC Authorization Code Flow with PKCE for browser and native public clients.
2. Do not embed client secrets in browser or mobile applications.
3. Validate token issuer, audience, signature, expiry, not-before, and relevant authentication context at the trusted server boundary.
4. Keep access tokens short-lived according to a separately reviewed security configuration; define refresh-token rotation/reuse behavior and logout/session revocation semantics during implementation design.
5. Do not treat client-supplied tenant IDs, branch IDs, role claims, or verification flags as authorization evidence.
6. Keep administrative Keycloak credentials and service accounts separate from end-user credentials and grant least privilege.

## 3. Staging-first adoption plan

The first authorized implementation phase, if separately approved, should be limited to a non-production staging environment:

1. Document supported Keycloak version selection and a reproducible deployment configuration.
2. Deploy Keycloak and its dedicated PostgreSQL persistence in staging, with TLS and secrets supplied through an approved secret-management mechanism.
3. Configure an OIDC staging client and integrate the provider-neutral authentication boundary with INFINYX.
4. Validate issuer/subject mapping, token validation, session behavior, logout, and failure handling.
5. Prototype and test email and phone verification flows without assuming a production SMS provider.
6. Test account linking, duplicate identity handling, tenant isolation, suspended/removed memberships, and branch authorization boundaries.
7. Exercise backup and restore, upgrade/rollback, monitoring, rate limits, and incident procedures.
8. Record test evidence, unresolved risks, and operational effort before proposing production topology.

Production deployment, public exposure, production credentials, high availability, and live message delivery are explicitly outside this ADR's implementation authorization.

## 4. Operational and security requirements

- Use a dedicated, persistent PostgreSQL database for Keycloak; do not share INFINYX application tables or database roles.
- Require TLS for externally reachable endpoints and protect administrative interfaces.
- Store signing keys, client secrets, database credentials, and adapter credentials in an approved secret manager; define rotation and recovery procedures.
- Establish tested encrypted backups and restore procedures for Keycloak configuration and identity data.
- Monitor availability, authentication failures, suspicious OTP activity, capacity, and provider errors without logging credentials, tokens, OTPs, or unnecessary personal data.
- Pin and review Keycloak versions and any extensions; extensions require compatibility tests and an ownership/maintenance plan.
- Document break-glass administration, access review, incident response, and upgrade/rollback procedures.
- Preserve INFINYX's tenant-scoped RLS and DAL protections. RLS tenant context is defense-in-depth and does not replace parameterized SQL, authorization checks, or independent security review.

## 5. Consequences

### Benefits

- Greater infrastructure and identity-data control.
- Reduced dependence on a managed identity SaaS provider.
- Standard OIDC integration and a provider-neutral application boundary.
- Clear separation between authentication and INFINYX business authorization.
- Staging evidence can inform production sizing and availability decisions.

### Costs and risks

- The team owns patching, upgrades, monitoring, backups, restore testing, capacity, and incident response.
- Email/phone OTP parity may require custom Keycloak extensions or adapters.
- SMS delivery reliability and regional availability are not guaranteed.
- Production availability and high-availability requirements remain unresolved until staging results and service objectives are reviewed.

## 6. Explicit non-goals and unresolved items

This ADR does not:
- authorize deployment or configuration of Keycloak in any environment;
- authorize code changes, authentication endpoints, UI, or production integration;
- select an SMS, email, or OTP delivery vendor;
- approve a custom Keycloak extension or authenticator implementation;
- define production high-availability topology, service-level objectives, capacity, or disaster-recovery targets;
- define final token lifetimes, refresh-token policy, or detailed session policy;
- authorize production credentials, live user migration, merge, release, or deployment.

These items require implementation designs and/or separate explicit founder approval as appropriate.

## 7. Governance

The founder has approved Keycloak Self-Hosted as the selected identity provider and staging-first as the adoption strategy. This ADR records the architecture decision only. Any implementation must proceed under a separate, bounded approval. Work remains on feat/adr-platform-foundation; main must remain unchanged. No merge, release, or deployment is authorized.
