# INFINYX Platform Core & Identity Architecture Design

- **Document status:** Proposed design / ready for engineering review
- **Scope:** E1-01 through E1-05 and E2-01
- **Implementation status:** Not implemented by this document
- **Security status:** Not independently audited; not approved for production
- **Target repository:** `hamidyaghobi70-beep/infinyx`
- **Baseline:** `main` at `6eb55bd5b22aabd148b1fcb846c083752c49a8cc`
- **Date:** 2026-11-16

> This document records architecture decisions and requirements developed during design. It does not assert that the described components exist in the current codebase. Concrete implementation must begin with a fresh repository inspection and compatibility review. The project implementation hold remains in effect unless separately and explicitly lifted.

---

## 1. Architectural principles

1. **Security and tenant isolation by default:** deny by default; no caller-supplied identity or tenant identifier is trusted.
2. **Modular monolith first:** retain clear module boundaries and in-process composition until measured requirements justify distribution.
3. **Explicit composition:** dependencies and modules are registered explicitly; no hidden discovery or initialization side effects.
4. **Deterministic lifecycle:** startup, readiness, admission control, draining, and shutdown have explicit state transitions.
5. **Bounded execution:** time, concurrency, input size, output size, and resource consumption have enforceable limits.
6. **Observable and auditable behavior:** lifecycle and security-relevant transitions produce structured, redacted telemetry.
7. **Evidence-based status:** distinguish DESIGNED, DOCUMENTED, IMPLEMENTED, TESTED, VERIFIED, and APPROVED FOR RELEASE.
8. **No implied production readiness:** passing unit tests or a successful build alone does not constitute a security audit or release approval.

## 2. E1-01 — Composition Root

### 2.1 Purpose

A single application composition boundary constructs infrastructure adapters, platform services, domain modules, API hosts, and workers, then connects them through explicit contracts.

### 2.2 Responsibilities

- Validate and normalize runtime configuration before constructing services.
- Construct shared infrastructure adapters and platform services.
- Register module instances and protected operations explicitly.
- Inject dependencies through interfaces/ports rather than allowing domain modules to instantiate infrastructure.
- Construct API and worker hosts from the same validated application composition where appropriate.
- Own startup and shutdown orchestration and resource ownership.
- Prevent accidental duplicate instances of singleton resources such as database pools and message clients.

### 2.3 Proposed layout

```text
src/bootstrap/
  composition-root.ts
  register-modules.ts
  register-operations.ts
  application-lifecycle.ts
  bootstrap-config.ts
```

This is a target layout, not a claim about the current repository tree. Paths must be reconciled against the actual code before implementation.

### 2.4 Invariants

- Domain modules do not import Express, database drivers, queue SDKs, or cloud SDKs directly.
- Infrastructure is injected through typed ports.
- No module performs hidden network connections during import or registration.
- Construction and initialization are separate, observable phases.
- Configuration and dependency failures prevent the application from accepting traffic.
- Test composition can replace infrastructure adapters with deterministic fakes.

### 2.5 Acceptance criteria

- Exactly one authoritative composition boundary exists per application host.
- Critical dependencies are explicit and inspectable.
- Duplicate or cyclic dependency construction is detected.
- Invalid configuration fails before the host begins accepting requests.
- Tests can construct the application without production credentials or external side effects.

## 3. E1-02 — Module Registry

### 3.1 Purpose

The Module Registry validates and manages the modules selected by the composition root. Registration does not itself grant authorization or activate external capabilities.

### 3.2 Module contract (conceptual)

```ts
interface PlatformModule {
  readonly id: string;
  readonly version: string;
  readonly dependencies: readonly ModuleDependency[];

  register(context: ModuleRegistrationContext): Promise<void>;
  start(context: ModuleStartContext): Promise<void>;
  stop(context: ModuleStopContext): Promise<void>;
}
```

The final contract must be reconciled with existing lifecycle interfaces and must not duplicate capabilities already implemented in the repository.

### 3.3 Registry responsibilities

- Explicit registration; no unrestricted filesystem/plugin auto-discovery.
- Reject duplicate module IDs and incompatible versions.
- Validate required dependencies and detect dependency cycles.
- Calculate deterministic startup order and reverse shutdown order.
- Distinguish required modules from optional modules.
- Expose module state and structured failure information.
- Prevent a module from self-granting permissions or silently registering privileged operations.

### 3.4 Lifecycle states

`DISCOVERED → VALIDATED → REGISTERED → INITIALIZED → READY → STOPPING → STOPPED`

Failure states must be explicit (for example, `FAILED`) and must not be represented as READY. State transitions must be validated and idempotent where applicable.

### 3.5 Security rules

- Module registration is not authorization.
- Agent module registration does not enable tools, external providers, memory access, or protected operations.
- Every privileged operation requires explicit registration, authorization policy, input validation, audit, and applicable approval.
- Optional modules may be disabled only when no required module depends on them.

### 3.6 Acceptance criteria

Tests cover duplicate IDs, missing dependencies, cycles, version incompatibility, deterministic ordering, partial startup failure, reverse-order shutdown, and attempts to register unauthorized capabilities.

## 4. E1-03 — Application Lifecycle

### 4.1 Purpose

The application lifecycle coordinates startup, admission, readiness, draining, and termination across API hosts, core services, modules, and workers.

### 4.2 Application states

`STOPPED → INITIALIZING → STARTING → READY → ACCEPTING → DRAINING → STOPPED`

A terminal or recoverable `FAILED` state must be defined. Invalid transitions are rejected. READY means all required startup gates passed; ACCEPTING means the host is permitted to admit work.

### 4.3 Startup sequence

1. Validate configuration and required secrets without logging secret values.
2. Construct the composition root and resource registry.
3. Verify critical infrastructure dependencies.
4. Validate database schema compatibility and migration state.
5. Register and initialize modules in dependency order.
6. Run required startup and security checks.
7. Publish readiness only after all critical gates pass.
8. Enable request/job admission.

Startup failure triggers bounded cleanup of resources already acquired. Database migrations must not run independently from every API or worker instance; migration execution requires a controlled, serialized deployment step or an explicitly designed leader/lock mechanism.

### 4.4 Shutdown sequence

1. Atomically close admission for new requests and operations.
2. Mark readiness false.
3. Stop workers from claiming new jobs.
4. Drain in-flight HTTP requests and admitted protected operations.
5. Track and settle child activities where possible.
6. Stop modules in reverse dependency order.
7. Close queues, storage clients, database pools, and remaining resources.
8. Emit a redacted shutdown report and terminate.

The sequence may include safe parallel phases, but all phases must share the same global deadline.

### 4.5 Health semantics

- `/health/live`: process liveness only; it should not fail merely because a remote dependency is unavailable.
- `/health/ready`: whether this instance can safely accept the workload it advertises.
- `/health/startup`: whether required startup initialization has completed.

Responses must not reveal credentials, connection strings, internal topology, tenant data, or sensitive exception details.

## 5. E1-04 — Global Shutdown Deadline

### 5.1 Requirement

One monotonic, absolute deadline governs the entire shutdown operation. Individual components may have smaller local budgets but cannot extend the global deadline.

### 5.2 Conceptual contract

```ts
interface ShutdownDeadline {
  readonly expiresAtMonotonic: number;
  remainingMs(): number;
  isExpired(): boolean;
  signal: AbortSignal;
}
```

Implementation must use a monotonic clock, propagate cancellation, and calculate remaining time at each boundary. Wall-clock timestamps may be recorded for telemetry but must not drive timeout arithmetic.

### 5.3 Cancellation and settlement

- Cancellation is cooperative for in-process asynchronous work.
- An aborted signal does not prove that the underlying Promise or external side effect has stopped.
- The runtime must distinguish “wait timed out” from “operation actually settled”.
- Child activities must be tracked and linked to their parent execution.
- Non-cooperative work requiring hard termination must run behind a process or infrastructure isolation boundary.

### 5.4 Child process policy

For managed child processes, use a bounded graceful termination phase followed by forced termination when supported. On POSIX, process-group handling may be required to terminate descendants; on Windows, use an appropriate Job Object or supervisor mechanism. A child must handle parent/IPC disconnect and exit paths. The design must not claim that killing one PID guarantees termination of its descendants.

### 5.5 Shutdown report

Record, with secrets and personal data redacted:

- start/end timestamps and configured deadline;
- final application state;
- completed, timed-out, failed, and still-unsettled activities;
- module cleanup results;
- child-process termination outcomes;
- resources whose closure could not be confirmed.

### 5.6 Acceptance tests

Cover concurrent operations under one deadline, non-cooperative promises, parent cancellation, child-process SIGTERM/SIGKILL escalation, descendant cleanup, IPC disconnect, repeated stop calls, cleanup failures, and deadline exhaustion. Process and operating-system scenarios require integration tests, not only unit tests.

## 6. E1-05 — Startup and Readiness Checks

### 6.1 Check categories

- Configuration: schema, required values, incompatible combinations.
- Secrets: presence, access, rotation metadata, and safe handling.
- Database: connectivity, schema compatibility, migration state, and pool configuration.
- Infrastructure: required cache, queue, and object storage dependencies.
- Modules: required module registration, initialization, and dependency health.
- Security: required authentication and authorization configuration, cryptographic material, and safe runtime settings.

### 6.2 Check result model

```ts
type CheckStatus = "PASS" | "FAIL" | "DEGRADED";

interface StartupCheckResult {
  id: string;
  status: CheckStatus;
  critical: boolean;
  durationMs: number;
  // Diagnostic details must be redacted and safe for authorized operators.
}
```

Each check must have a timeout, bounded output, and explicit criticality. Independent checks may run concurrently. A failed critical check blocks READY. DEGRADED is permitted only for explicitly optional capabilities with documented dependency rules.

### 6.3 Database migration policy

- Verify schema compatibility before admitting traffic.
- Use expand/migrate/contract for changes requiring rolling deployment.
- Serialize migration execution.
- Do not run migrations concurrently from every application replica.
- Fail closed when the application code is incompatible with the database schema.
- Define rollback or forward-fix procedures for failed deployments.

### 6.4 Acceptance criteria

Tests cover invalid configuration, unavailable critical dependencies, optional dependency degradation, incompatible schema, migration lock contention, check timeout, readiness transitions after runtime dependency failure, and redaction of secret-bearing errors.

## 7. E2-01 — Identity Provider and Authentication Architecture

### 7.1 Responsibility boundary

The Identity Provider authenticates the subject. INFINYX owns application identity mapping, tenant membership, business authorization, resource authorization, and audit decisions. An authenticated identity does not automatically grant access to a tenant or business resource.

### 7.2 Standards and flows

- OpenID Connect for authentication and identity claims.
- OAuth 2.0 for delegated authorization.
- Authorization Code Flow with PKCE S256 for browser/public clients.
- Validate `state`, `nonce`, issuer, audience, signature, expiry, and applicable token claims.
- Use exact redirect URI allowlists and safe callback handling.
- Do not use an ID Token as an API access token.
- Do not treat client-supplied claims, headers, `actorId`, or `tenantId` as proof of identity or authorization.

The implementation must follow current OAuth/OIDC security best practice and the applicable provider's security guidance.

### 7.3 Identity Provider evaluation

Candidates for a documented comparison include Keycloak, ZITADEL, and Auth0. No provider is selected by this design. Evaluate:

- security capabilities and patch cadence;
- OIDC conformance and MFA/passkey support;
- session and refresh-token revocation semantics;
- multi-region availability and recovery;
- data residency and privacy requirements;
- operational burden, observability, extensibility, and total cost;
- migration/export strategy and vendor lock-in.

The final provider choice requires an explicit Architecture Decision Record and threat-model review.

### 7.4 Session architecture

For the first-party web application, prefer a server-managed session with an opaque, high-entropy identifier in a cookie configured with `HttpOnly`, `Secure`, and an appropriate `SameSite` policy. Apply CSRF defenses to state-changing cookie-authenticated requests.

Session requirements:

- rotate session identifiers after authentication and privilege changes;
- enforce idle and absolute expiration;
- revoke sessions on logout, compromise, and relevant account-security events;
- support device/session inventory and administrative revocation;
- protect session storage and avoid logging session identifiers or tokens;
- define refresh-token rotation/reuse detection if refresh tokens are used;
- never store sensitive bearer credentials in browser local storage by default.

Exact cookie domain, SameSite mode, CSRF mechanism, and cross-origin policy must be decided against the final deployment topology.

### 7.5 Trusted Principal boundary

After successful server-side validation, the application may construct an immutable internal principal containing only verified identity attributes, such as subject identifier, issuer, authentication time, session identifier, and authentication method. Tenant membership and roles are resolved separately by INFINYX; they are not accepted from arbitrary request input.

A later E2-02 design must define the exact principal contract, trust boundary, service-to-service identity, impersonation controls, and audit requirements.

### 7.6 Acceptance tests

Cover invalid signature, wrong issuer/audience, expired token, nonce/state mismatch, PKCE failure, redirect URI mismatch, session fixation, session revocation, CSRF, replay/reuse detection where applicable, and attempts to spoof user or tenant identifiers. Include negative authorization tests and security integration tests against the selected provider.

## 8. Cross-cutting observability and audit

- Use correlation IDs across HTTP requests, protected operations, jobs, and child activities.
- Record security-relevant events in a durable audit system with access controls and integrity protections.
- Keep operational logs separate from audit records.
- Redact credentials, session IDs, access tokens, payment data, and unnecessary personal data.
- Emit metrics for startup duration, readiness transitions, shutdown duration, timed-out operations, module failures, and dependency health.
- Do not expose detailed internal check results through public health endpoints.

## 9. Consolidated verification matrix

| Area | Minimum evidence |
|---|---|
| Composition Root | Unit and composition tests; no hidden side effects |
| Module Registry | Dependency graph, deterministic order, negative registration tests |
| Lifecycle | State transition, startup failure, repeated shutdown tests |
| Global Deadline | Concurrency and process-level failure-injection tests |
| Readiness | Critical/optional dependency and redaction tests |
| Authentication | OIDC integration and token-validation negative tests |
| Session | Fixation, CSRF, expiry, rotation, and revocation tests |
| Security | Independent threat-model review and evidence-based audit |

Passing this matrix is necessary but not sufficient for production approval. Independent review, operational readiness, and release authorization remain separate gates.

## 10. Status and next steps

| Stage | Design status | Documentation status in this PR | Implementation |
|---|---|---|---|
| E1-01 Composition Root | Designed | Included | Not implemented |
| E1-02 Module Registry | Designed | Included | Not implemented |
| E1-03 Application Lifecycle | Designed | Included | Not implemented |
| E1-04 Global Shutdown Deadline | Designed | Included | Not implemented |
| E1-05 Startup & Readiness | Designed | Included | Not implemented |
| E2-01 Identity Provider & Authentication | Designed | Included | Not implemented |

Next design stage: **E2-02 — Trusted Principal Architecture**.

Before implementation, inspect the current target branch and reconcile these contracts with the actual code, existing lifecycle primitives, current PRs, and CI workflow. Do not merge this design or infer production/security approval from documentation alone.

---

## References

- RFC 9700 — Best Current Practice for OAuth 2.0 Security.
- OpenID Connect Core 1.0.
- OAuth 2.0 for Browser-Based Applications (IETF Best Current Practice work).
- OWASP Session Management Cheat Sheet.
- OWASP Authentication Cheat Sheet.
