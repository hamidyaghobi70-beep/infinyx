# INFINYX E2-02 — Trusted Principal Architecture

- **Status:** DESIGNED — documentation proposal; not implemented or security-certified.
- **Program:** INFINYX V3 / Engineering Execution Plan
- **Stage:** E2-02
- **Depends on:** E2-01 Identity Provider & Authentication Architecture; E1 lifecycle and composition-root design.
- **Repository:** `hamidyaghobi70-beep/infinyx`
- **Scope:** Establish the trusted, immutable identity context consumed by authorization, tenant resolution, protected operations, audit, and future agent execution.

## 1. Objective and security invariant

INFINYX must have one authoritative answer to: **who or what is making this request, how was that identity authenticated, and under which verified security context is it acting?**

The platform MUST construct a `TrustedPrincipal` only from a successfully verified authentication mechanism. A request body, query parameter, header supplied by an untrusted client, module argument, or caller-provided `actorId` is never an identity authority.

Core invariant:

> No protected operation may derive its authority from identity or tenant attributes supplied by the caller. Authority must flow from a verified credential to a server-created principal, then through explicit authorization and tenant-context resolution.

This stage defines identity provenance and propagation. It does **not** grant permissions, select an identity-provider vendor, implement authentication, or authorize a release.

## 2. Terminology and trust boundaries

| Concept | Meaning | Authority |
|---|---|---|
| Credential | Evidence presented to authenticate a subject (OIDC token, session cookie, workload credential, API key) | Untrusted until verified |
| Authenticated subject | Stable identity established by a verifier | Authentication subsystem |
| TrustedPrincipal | Immutable server-side representation of the verified subject and authentication evidence | Principal factory only |
| Actor | Entity performing an action in the current execution | Derived from principal or explicit delegation |
| Subject/resource owner | Entity or resource an action affects | Domain data; not automatically the actor |
| TenantContext | Verified tenant and membership context selected for this request | Membership/tenant resolver |
| Authorization decision | Allow/deny for an action on a resource in context | Policy/authorization subsystem |
| Delegation | Explicit, bounded authority to act on behalf of another principal | Delegation service and policy |

Authentication answers who authenticated. Tenant resolution answers which tenant context is active. Authorization answers whether the actor may perform a specific action. These are separate decisions and MUST NOT be collapsed into a single middleware boolean.

### Trust boundary sequence

```text
Untrusted request
   -> Credential extraction
   -> Credential verification
   -> TrustedPrincipal factory
   -> Tenant membership resolution
   -> Authorization / resource policy
   -> Protected operation admission
   -> Domain action + audit
```

Any failure before protected-operation admission is fail-closed.

## 3. Canonical principal contract

The application-level contract SHOULD be equivalent to the following conceptual shape. This is a design contract, not a request to add code in this documentation stage.

```ts
type PrincipalKind = "human" | "service" | "agent";

interface TrustedPrincipal {
  readonly principalId: string;       // Internal stable subject identifier
  readonly kind: PrincipalKind;
  readonly issuer: string;            // Verified issuer / trust domain
  readonly externalSubject: string;   // Issuer-scoped subject; never globally unique alone
  readonly authenticationMethod: string;
  readonly authenticatedAt: string;  // Server-normalized timestamp
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly sessionId?: string;        // Opaque internal session reference
  readonly assuranceLevel?: string;   // Normalized, policy-defined assurance
  readonly authContext?: readonly string[];
  readonly credentialId?: string;    // Non-secret identifier for rotation/revocation
  readonly delegation?: DelegationContext;
  readonly correlationId: string;
}
```

The final TypeScript representation MUST be refined through ADRs and implementation review. Important constraints:

1. `principalId` is an internal stable identifier mapped from a verified issuer/subject pair. The pair `(issuer, externalSubject)` is unique; `externalSubject` alone is not.
2. Raw access tokens, refresh tokens, passwords, private keys, cookies, API-key values, and other bearer secrets MUST NOT be stored in the principal or copied into logs.
3. Principal fields are immutable after construction. Use defensive copying for nested collections; do not expose mutable references.
4. Timestamps are normalized and checked for validity, skew, expiry, and ordering. Expired credentials never produce an active principal.
5. Authentication evidence is descriptive, not an authorization grant. An `assuranceLevel` or `authContext` cannot independently grant access.
6. Optional fields are omitted when unknown; unknown must not be silently converted into a stronger assurance level.
7. Principal construction is restricted to trusted verifier adapters and an internal factory. Domain modules cannot instantiate arbitrary trusted principals.
8. Serialization across process boundaries requires an authenticated, integrity-protected envelope with audience, expiry, issuer, and replay controls. Do not serialize an in-process principal and assume it remains trusted.

## 4. Principal kinds and identity provenance

### 4.1 Human principal

- Created only after successful verification of an OIDC identity or a separately approved authentication mechanism.
- Internal user mapping is keyed by verified issuer plus subject, with explicit account-linking controls.
- Email, display name, phone number, and profile attributes are claims, not stable identity keys and not proof of tenant membership.
- Account linking requires proof of control of both identities and must resist email-collision and pre-hijacking scenarios.

### 4.2 Service principal

- Represents a workload, integration, or backend service, not a human user.
- Prefer short-lived workload identity or client credentials with asymmetric keys and rotation.
- Scope is explicit: permitted audience, service identity, operations, environment, and expiry.
- A service principal MUST NOT be silently mapped to a human user or inherit a human's interactive session.
- Long-lived static secrets are a migration exception, not the target design.

### 4.3 Agent principal

- Represents an INFINYX-managed agent runtime or agent identity.
- An agent receives no ambient user or tenant authority.
- Agent execution MUST be bound to an initiating principal, a verified tenant context, an approved capability set, and an explicit delegation record.
- Agent permissions are narrower than or equal to the delegator's approved scope, and may be further reduced by policy.
- Agent identity is not proof that a human approved an action. Human approval must be a separate, attributable, time-bounded authorization artifact.

## 5. Delegation and acting on behalf of another principal

Delegation MUST be explicit and represented as a first-class, auditable context. It must not be inferred from a user ID passed in a request.

A conceptual `DelegationContext` contains:

- delegator principal identifier;
- delegate principal identifier;
- tenant identifier to which the delegation is bound;
- allowed action/resource scope;
- purpose and originating workflow/run identifier;
- issued-at and expiry;
- approval reference, where required;
- revocation/version reference;
- maximum depth (default 1; nested delegation disabled unless separately designed).

Rules:

1. Delegation is deny-by-default and least-privilege.
2. The effective authority is the intersection of delegator authority, delegated scope, tenant membership, agent/service capability, and current policy.
3. Delegation cannot cross tenant boundaries unless a separately approved cross-tenant workflow explicitly authorizes it.
4. Delegation cannot be widened by the delegate.
5. High-impact actions require fresh policy evaluation and, where defined by policy, human approval and step-up authentication.
6. Revocation and expiry are checked at execution/admission time; cached grants must not outlive their revocation model.
7. Audit records preserve both the acting principal and the delegator. Never overwrite the actor with the person on whose behalf the action occurred.

## 6. Tenant context is separate from principal

A verified principal may be a member of zero, one, or many tenants. Authentication alone does not select or authorize a tenant.

Tenant resolution MUST:

1. Accept a requested tenant selector only as an untrusted *selection hint* (for example, a route slug or tenant handle).
2. Resolve the selector to a canonical internal tenant ID.
3. Verify active membership or a separately authorized service/agent relationship.
4. Verify membership status and any relevant tenant restrictions.
5. Produce a server-owned immutable `TenantContext` bound to the principal and request.
6. Re-check authorization for the requested action and resource.

A tenant ID supplied in a URL, header, body, job payload, or message is never sufficient proof of access. Never trust a client-supplied `tenantId` or `actorId` as an authorization fact.

Conceptual context:

```ts
interface TenantContext {
  readonly tenantId: string;
  readonly membershipId?: string;
  readonly membershipVersion?: number;
  readonly principalId: string;
  readonly resolvedAt: string;
  readonly contextId: string;
}
```

For system-level jobs without a tenant, use an explicit system context with a narrow system capability. Do not invent a tenant or use a magic tenant ID.

## 7. Request execution context and propagation

After authentication and tenant resolution, the application constructs an immutable `RequestExecutionContext` containing:

- TrustedPrincipal;
- optional TenantContext;
- request/correlation/trace identifiers;
- cancellation signal and deadline;
- verified authentication and delegation metadata;
- safe client metadata required for policy/audit (never credential values).

Propagation rules:

- Context is created at the trusted ingress boundary and passed explicitly through application services and protected-operation APIs.
- Do not use mutable process-global identity, ambient singleton state, or caller-controlled AsyncLocalStorage values as the sole authority source.
- Background jobs carry a signed or otherwise authenticated, integrity-protected execution envelope. Workers re-validate issuer, audience, expiry, tenant membership/policy, and revocation as required.
- A job payload's `actorId` or `tenantId` is descriptive until verified against the trusted envelope and current records.
- Child tasks inherit a bounded context and cancellation/deadline. They cannot silently replace the principal or widen the tenant.
- Cross-service propagation uses short-lived audience-bound credentials or authenticated service-to-service envelopes, not raw browser tokens forwarded indiscriminately.
- Context snapshots are immutable and bounded; reject unsupported structures and oversized metadata.

## 8. Authentication verification and session lifecycle

This stage depends on E2-01 and does not choose an IdP. The verifier adapter must validate, as applicable:

- cryptographic signature and permitted algorithm;
- exact trusted issuer;
- intended audience and authorized client;
- expiry and not-before;
- nonce/state/PKCE at the appropriate OIDC flow boundary;
- key rotation and JWKS cache behavior;
- token type and intended use (ID token is not an API access token);
- required authentication context and step-up age for sensitive actions.

For browser sessions, the server-side session is the revocable authority reference. Cookies should be opaque, Secure, HttpOnly, and appropriately SameSite; state-changing requests require CSRF protection. Session rotation occurs after authentication and privilege changes. Logout/revocation invalidates the server-side session and relevant caches according to a documented consistency target.

A signed token is not automatically revocable. The design must explicitly choose and test the revocation mechanism (short token lifetime, session lookup, denylist/version, introspection, or a justified combination). Cache TTL must not exceed the security freshness requirement.

## 9. Failure semantics

| Condition | Required result |
|---|---|
| Missing, malformed, expired, or invalid credential | Reject as unauthenticated |
| Unknown issuer, invalid audience, unsupported algorithm | Reject; never fall back to a weaker verifier |
| Ambiguous issuer/subject mapping | Reject and require controlled identity resolution |
| Revoked session or credential | Reject according to revocation consistency contract |
| Missing/inactive tenant membership | Deny tenant-scoped operation |
| Tenant selector does not match verified membership | Deny without disclosing another tenant's data |
| Invalid or expired delegation | Deny delegated operation |
| Missing assurance for a sensitive action | Require step-up or deny |
| Principal/context construction failure | Fail closed; do not continue anonymously |
| Authorization or membership service unavailable | Deny protected action; do not use stale allow by default |

Public, anonymous routes must be explicitly classified and receive an explicit anonymous context. Absence of a principal must never be interpreted as a privileged system identity.

## 10. Audit, privacy, and observability

Security-relevant events SHOULD include authentication success/failure, session creation/rotation/revocation, identity linking, membership changes, delegation creation/revocation, principal-kind changes, and authorization denials.

Audit event fields should include:

- event ID and timestamp;
- acting principal ID and principal kind;
- delegator ID, if applicable;
- tenant ID, only after verified resolution;
- action, resource type/opaque resource ID, decision and policy version;
- authentication method/assurance reference where relevant;
- request/correlation/trace IDs;
- reason code suitable for security review.

Never log credentials, raw tokens, session cookies, password material, private keys, full sensitive claims, or unnecessary personal data. Separate security audit from diagnostic logs, protect audit integrity, restrict access, and define retention under privacy/legal review. Avoid leaking whether a foreign tenant or account exists in client-visible errors.

## 11. Threats and mitigations

| Threat | Severity | Primary mitigation |
|---|---:|---|
| Spoofed actor ID / caller impersonation | Critical | Principal factory from verified credentials; ignore caller identity fields |
| Cross-tenant context substitution | Critical | Membership-backed tenant resolver; resource authorization; tenant-aware data layer |
| Token substitution / confused deputy | High | Strict issuer, audience, token type, purpose, and service identity validation |
| Stale session or credential after revocation | High | Explicit revocation consistency contract; bounded cache; tests |
| Agent privilege escalation | Critical | Explicit delegation, capability intersection, no ambient authority |
| Forged job or event envelope | Critical | Authenticated integrity-protected envelope, audience/expiry/replay checks |
| Principal mutation / context race | High | Immutable bounded snapshots and explicit propagation |
| Identity linking takeover | High | Proof of control, collision handling, audit, no email-only auto-link |
| Sensitive claims leaked in logs | High | Allowlisted audit fields, redaction, log tests |
| Fail-open on IdP/membership outage | Critical | Fail-closed protected operations and explicit availability policy |

## 12. Acceptance criteria

- **TP-01:** Only trusted verifier adapters can create a TrustedPrincipal.
- **TP-02:** Issuer plus subject maps unambiguously to an internal principal; subject alone cannot.
- **TP-03:** Caller-provided actor/user IDs never establish identity or authority.
- **TP-04:** Tenant selection is a hint; active membership or approved service relationship is required.
- **TP-05:** Principal, TenantContext, and RequestExecutionContext are immutable and defensively copied.
- **TP-06:** Human, service, and agent principals are distinct and cannot be silently interchanged.
- **TP-07:** Delegation is explicit, bounded, revocable, tenant-bound, and auditable.
- **TP-08:** Job and cross-service context propagation is authenticated, audience-bound, expiring, and replay-resistant.
- **TP-09:** Expiry, revocation, issuer, audience, token type, and assurance semantics are documented and tested.
- **TP-10:** All protected operations fail closed on identity, tenant, or authorization uncertainty.
- **TP-11:** Audit captures actor and delegator separately without recording secrets.
- **TP-12:** Anonymous routes and system-level jobs are explicit and least-privileged.

## 13. Required verification matrix

| Test ID | Scenario | Expected outcome |
|---|---|---|
| TP-T01 | Forged `actorId` in body/header | Identity remains verified principal; forged value ignored |
| TP-T02 | Same subject from different issuers | Distinct identities unless explicitly linked |
| TP-T03 | Expired, wrong-audience, wrong-issuer, invalid-signature token | Reject |
| TP-T04 | ID token presented as API access token | Reject |
| TP-T05 | User selects tenant without active membership | Deny |
| TP-T06 | Membership revoked between requests | Deny within documented revocation SLA |
| TP-T07 | Mutate source claims after principal construction | Principal unchanged |
| TP-T08 | Mutate nested auth-context array | Principal unchanged |
| TP-T09 | Agent attempts action outside delegation | Deny and audit |
| TP-T10 | Delegate attempts to widen scope or tenant | Deny |
| TP-T11 | Forged/expired/replayed job envelope | Reject |
| TP-T12 | Membership or identity service unavailable | Protected action denied |
| TP-T13 | Sensitive claims/token accidentally included in log context | Redaction test passes |
| TP-T14 | Concurrent requests for different tenants | No context leakage across requests |
| TP-T15 | Anonymous request reaches protected operation | Deny |
| TP-T16 | Revoked session with warm cache | Deny within defined consistency target |

Tests must use deterministic barriers and controlled clocks rather than arbitrary sleeps. Include unit, contract, integration, concurrency, and security regression tests. A green CI run alone is not a security certification.

## 14. Decisions intentionally left open

The following require explicit ADRs or product/security decisions; this design does not silently choose them:

1. Identity provider/vendor and deployment topology.
2. Canonical internal principal ID format and account-linking policy.
3. Session store, revocation mechanism, and maximum revocation propagation delay.
4. Assurance-level vocabulary and step-up policy for financial, destructive, and administrative actions.
5. Workload identity mechanism and credential rotation.
6. Agent delegation UX, approval policy, and maximum delegation lifetime.
7. Cross-tenant administrative/support access model, including break-glass controls.
8. Data retention, audit retention, and applicable data-residency requirements.

## 15. Dependencies and implementation sequence

1. Complete E2-01 IdP/authentication architecture and record the chosen verification boundary.
2. Define principal and tenant context interfaces in a dedicated ADR.
3. Implement verifier adapters and the restricted principal factory.
4. Implement tenant membership resolution separately from authentication.
5. Propagate immutable execution context into application and protected-operation boundaries.
6. Add service identity and job-envelope verification before enabling background privileged work.
7. Add agent delegation only after capability authorization, approval, and audit controls are implemented.
8. Run the full verification matrix and independent security review before enabling protected production workflows.

## 16. Status and release gate

- Design: **DESIGNED**.
- Documentation registration: pending this PR.
- Implementation: **NOT IMPLEMENTED by this stage**.
- Tests: **NOT RUN for this design**.
- Independent review: **PENDING**.
- Release approval: **NOT APPROVED**.

This document is a proposed architecture contract. It does not establish that authentication, authorization, tenant isolation, delegation, audit integrity, or any production control currently exists in the codebase.
