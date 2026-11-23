# INFINYX Core Engine — staged engineering plan

## Operating constraints

- Repository: `hamidyaghobi70-beep/infinyx`.
- Current engineering baseline: `fix/core-engine-shutdown-v6`.
- Work is isolated on `work/core-engine-v1-hardening`.
- `main` is out of scope and must remain unchanged.
- No merge, auto-merge, release, or deployment without separate explicit project-owner approval.
- Existing Core Engine v1 code is the baseline; do not rewrite working subsystems without a demonstrated defect and regression test.

## Stage 0 — repository inventory (complete)

Evidence reviewed:
- All seven repository branches returned by branch search.
- Foundation package manifest, lockfile, and Vitest configuration.
- Branch comparisons from Foundation to feature, experiment, and Shutdown revisions v4/v5/v6.
- Core Engine contracts, lifecycle implementation, server runtime, tests, CI workflow, and engineering documents on v6.
- All discoverable repository PRs at the time of review, including their review submissions and inline threads.

Decision: continue from Shutdown v6, not from `main` or the earlier feature branch.

## Stage 1 — process shutdown hardening (complete; CI evidence recorded)

Current v6 coverage includes:
- Real child-process SIGINT/SIGTERM scenarios on POSIX platforms.
- IPC graceful-shutdown coverage for platforms without POSIX signal semantics.
- Exactly-once cleanup and exit assertions.
- Unit/integration coverage for fatal-event handling and shutdown races.

This revision adds real child-process scenarios for:
- `uncaughtException`.
- `unhandledRejection`.
- Exactly one module cleanup and a non-zero process exit for either fatal event.

Acceptance gate:
1. Node 22 lockfile installation succeeds.
2. Typecheck, build, Vitest, and process-level tests pass.
3. Linux and macOS execute POSIX signal tests; Windows reports those tests as Skip and runs IPC coverage.
4. Dependency audit has no unaccepted high-severity findings.
5. CI evidence is recorded against the exact reviewed commit.
6. Independent review findings are reconciled before merge is considered.

Status: CI passed for commit `ec31eba7ce8b87ea5d21873ff998ca22b9c2c0e3`.

Evidence:
- Core Engine matrix run `41149899891`: Ubuntu, macOS, and Windows jobs all succeeded.
- Ubuntu and macOS each passed 54 Vitest tests and all 6 process-level tests.
- Windows passed 54 Vitest tests; process-level suite reported 3 Passed and 3 Skipped (POSIX-only SIGINT/SIGTERM cases), with IPC coverage executed.
- Dependency Security Audit run `41149899902` succeeded.
- Windows skips are platform-expected, not failures.

Stage 1 acceptance is satisfied for the recorded commit `ec31eba7ce8b87ea5d21873ff998ca22b9c2c0e3`. The evidence above is commit-specific; later stages have separate CI evidence below.

## Stage 2 — lifecycle and module-registry contract verification (complete)

Audit the existing implementation before changing it. Verify and add regression tests, where missing, for:
- Duplicate module identifiers.
- Missing dependencies and dependency cycles.
- Deterministic dependency ordering.
- Registration restrictions after initialization begins.
- Initialization/start rollback and reverse-order cleanup.
- Failed cleanup retry semantics and idempotency expectations.
- Re-entrant and concurrent stop calls.
- State transitions after partial failures.

### Audit finding (medium severity): class-based module hooks are lost at registration

- File: `src/core/module-registry.ts`, `register()`.
- Root cause: object spread (`{ ...module }`) copies only own enumerable properties. A valid class instance implementing `CoreModule` has lifecycle methods on its prototype; these hooks are omitted from the registered snapshot. The module then appears registered but its `initialize`, `start`, and `stop` methods are not invoked. Methods depending on instance state also require their original receiver.
- Change: build an immutable metadata snapshot and bind present lifecycle hooks to the source instance.
- Regression acceptance: register a class implementing `CoreModule` with instance-state-dependent `initialize`, `start`, and `stop`; drive it through `CoreEngine.initialize()`, `start()`, and `stop()`; assert all three hooks execute once with the correct instance context.
- Status: fix and regression test committed to the work branch. CI run 41150444754 for Stage 2 commit 9a54726fbafd0d120e6d7b039e5a6b1d0c32331b completed successfully on Ubuntu, Windows, and macOS; all steps in all three jobs passed.

Existing checks confirmed in v6: duplicate identifiers, missing dependencies, dependency cycles, dependency-first ordering, registration cutoff, startup/initialization rollback, cleanup retry, reverse-order stop, concurrent stop promise sharing, and re-entrant stop protection.

Remaining coverage opportunities (not yet established as defects): very deep dependency graphs, repeated dependency declarations, malformed runtime inputs from untyped JavaScript callers, and explicit state-transition tables for every partial-failure boundary. These should be tested before deciding whether code changes are warranted.

## Stage 3 — event and policy boundaries

Verify:
- Event handler ordering and async completion semantics.
- Failure isolation/reporting for multiple subscribers.
- Subscription disposal and memory-leak behavior.
- Default-deny policy behavior.
- Fail-closed handling when a policy implementation errors or times out.
- Explicit actor, action, resource, and context requirements.

Keep policy evaluation separate from execution. Do not enable agent or tool execution as part of this stage.

## Stage 3 — Event Bus and Policy Engine audit (complete; independent review accepted)

### Event Bus behavior verified
- Subscribers are held in per-event Set buckets; unsubscribe deletes the handler and removes an empty bucket.
- publish() snapshots the current subscriber set. Handlers are invoked in subscription order.
- Handler work is concurrent rather than serial; publish() waits for every returned promise to settle, then reports collected failures in an AggregateError.
- A synchronous throw previously escaped the map() expression before Promise.allSettled() was reached, preventing later subscribers from running. This was a confirmed failure-isolation defect.
- Fix: schedule each handler invocation through Promise.resolve().then(...), so synchronous throws become rejected promises and every subscriber is dispatched.
- Regression: test/core/event-bus.test.ts verifies that a synchronous throw does not block sibling handlers and that publication waits for a gated asynchronous handler before rejecting.
- Disposal: the implementation removes disposed handlers and deletes empty buckets; the existing unsubscribe test confirms disposed handlers are not called by later publishes. No retained-listener leak was demonstrated by this implementation/test scope.

### Policy behavior and boundary
- The built-in DefaultDenyPolicyEngine returns deny when no explicit policy is injected; existing CoreEngine tests assert this default.
- Before this stage, an injected evaluator was passed through directly. A thrown/rejected evaluator error escaped as a rejection, and a never-settling evaluator had no deadline. The boundary therefore did not itself guarantee a deny decision on evaluator failure or timeout.
- Fix: add FailClosedPolicyEngine and wrap injected policies in CoreEngine. Evaluation errors and configured timeouts return explicit deny decisions. Default timeout is 5,000 ms and can be configured through CoreEngineOptions.policyTimeoutMs (must be positive and finite).
- Regression coverage: test/core/fail-closed-policy-engine.test.ts covers explicit allow preservation, synchronous and asynchronous evaluator errors, timeout denial, CoreEngine injection wrapping, and invalid timeout configuration.
- Separation: the policy component only evaluates a PolicyRequest and returns a PolicyDecision. CoreEngine does not execute actions based on that decision; no Agent or Tool Execution path was enabled or added.
- Timeout limitation: the interface has no cancellation signal, so a timed-out evaluator is denied at the boundary but its underlying work is not forcibly cancelled.

### Policy decision validation and request/context contract

- The Policy boundary validates evaluator output before returning it to callers. Only a plain object with an exact `effect` value of `allow` or `deny` and a non-empty string `reason` is accepted. `null`, `undefined`, primitives, arrays, missing fields, invalid effects, and blank reasons become an explicit deny.
- Policy input is validated before invoking injected evaluator code. `actorId`, `action`, and `resource` are mandatory non-empty strings (whitespace-only values are rejected; accepted values are not silently rewritten).
- `context` is optional. When present it must be a plain object matching `PolicyContext`.
- `PolicyContext.attributes` is optional and, when present, must be a plain string-keyed object. Attribute values remain opaque to Core Engine v1. Empty/whitespace attribute keys are rejected.
- `attributes` is not itself the Context; it is the optional attribute map nested under `context`. No authentication or semantic validation of individual attribute values is implied by this structural contract.
- Regression coverage in `test/core/fail-closed-policy-engine.test.ts` covers null/undefined and malformed evaluator decisions, malformed required request fields, invalid context/attributes shapes, rejection before evaluator invocation, and acceptance of a valid context envelope.
- Open risk retained: timeout returns deny to the caller but does not cancel the underlying evaluator. The current PolicyEngine contract has no AbortSignal/cancellation protocol; a timed-out evaluator may continue consuming resources or performing its own internal work. This must be addressed before any future execution-sensitive integration.

### Stage 3 status — accepted by independent review
- Independent review by Hanieh accepted Stage 3 code, Policy contract, regression tests, and three-platform CI on final code/test SHA `016d98609a725246d2aca105f6b8560d55d1df52`.
- Final verification run [41151990059](https://github.com/hamidyaghobi70-beep/infinyx/actions/runs/41151990059) completed successfully on that exact SHA. Ubuntu and macOS each passed 80/80 Vitest tests and 6/6 process integration tests. Windows passed 80/80 Vitest tests and 3 process integration tests; 3 POSIX-only signal cases were skipped as expected. Type check, build, and dependency security audit succeeded on all three platforms; npm audit reported 0 vulnerabilities.
- Earlier Stage 3 implementation CI run [41151324141](https://github.com/hamidyaghobi70-beep/infinyx/actions/runs/41151324141) passed for its then-current code commit `495abda249ee5c67f670273b8eb020c51a59064d`. It is historical evidence for that SHA, not a substitute for the final run above.
- Open risk retained: the timeout boundary returns deny but cannot cancel the underlying evaluator because the PolicyEngine contract has no AbortSignal/cancellation protocol. This remains unresolved and must be addressed before execution-sensitive integration.
- Technical debt recorded from Hanieh's independent review: a Node.js deprecation warning concerning `url.parse()`. Track and replace the deprecated API in a separately scoped change; this documentation update does not claim the warning is fixed.
- Agent and Tool Execution remain out of scope and disabled.
- No merge, release, or deployment is authorized by this roadmap update.


## Stage 4 — memory and persistence boundary

Core Engine retains the stable MemoryPort contract and now includes partial PostgreSQL, encryption, audit, migration, and deletion-replay library adapters. These components are not yet safe to connect to a live runtime; the remaining production gates are listed below.

### Stage 4 progress — owner decisions recorded; implementation still gated

- Existing controls and acceptance criteria remain documented in
  [`docs/security/memory-boundary-stage4.md`](../security/memory-boundary-stage4.md).
- `GuardedMemoryPort` and `InMemoryMemoryStore` remain the implemented guarded boundary
  and non-durable reference store; the public `MemoryPort` contract is unchanged.
- Founder delegated the six design choices. The selected baseline is recorded in
  [ADR-0001](../architecture/decisions/adr-0001-stage4-persistent-memory.md):
  PostgreSQL; TLS plus AES-256-GCM envelope encryption with external KMS custody;
  90-day default memory retention and 30-day encrypted backup retention; separate
  append-only audit schema/roles with signed external checkpoints; versioned canonical
  JSON envelopes with resumable migrations; and four-level data classification with
  Restricted data denied by default.
- Initial implementation on this draft branch: AES-256-GCM envelope cipher with injected key-provider contract and bounded re-encryption support; PostgreSQL `MemoryPort` adapter with explicit tenant column/tenant-qualified queries, 90-day default expiry, bounded tenant-qualified expiry sweep, and explicit classification allow-list; transactional PostgreSQL audit writer with hash-chain sequencing; baseline schema and least-privilege NOLOGIN role migrations; checksum-protected, advisory-lock-serialized PostgreSQL migration runner; and a deletion tombstone/replay coordinator designed to sit beneath `GuardedMemoryPort`.
- Focused tests cover the cipher, adapter, audit writer, migration runner, and deletion replay contract. CI run `45218422158` passed all four jobs (Ubuntu, macOS, Windows, and Dependency Security Audit) on head `bd113dd7d4aee4db822b772509e1f2bcb12d0dc3`. Later authentication hardening commits are not covered by that run and require a fresh exact-head CI result.
- This is **partial library implementation**, not production-ready persistence. No concrete cloud KMS adapter, external tombstone ledger, backup/restore provider or restore drill, external signed audit checkpoints, trusted authenticated identity composition, or live PostgreSQL/KMS integration test is complete. No persistence adapter is wired into the server or live Core runtime.
- Persistence must remain disconnected from live user traffic until the request-scoped authenticated memory factory is integrated into a real workload and the ADR implementation gates pass. The factory now provides the principal-to-scope boundary, but it does not itself configure KMS, PostgreSQL, or a user-facing route.
- Agent and Tool Execution remain disabled. No merge, release, deployment, or runtime
  activation is authorized by this update.
## Stage 5 — authenticated identity and execution boundaries

### Authenticated identity — implementation present, deployment trust not configured
- A configurable RS256 verifier, bearer middleware, verified-principal guard, and authenticated identity introspection route exist.
- JWT verification is restricted to RSA keys of at least 2048 bits, canonical base64url segments, the RS256 algorithm, and the configured issuer/audience/expiry contract.
- The actual identity provider, issuer, API audience, and public signing key/JWKS source have not been supplied by the owner. Production authentication therefore remains unconfigured; do not guess trust anchors.
- Added a bounded OIDC/JWKS resolver and wired it into the server through an asynchronous RS256 verifier and fail-closed bearer middleware. Configuration requires `AUTH_ISSUER`, `AUTH_AUDIENCE`, and exactly one of `AUTH_JWKS_URL` or `AUTH_PUBLIC_KEY_PEM`; trust anchors are operator-supplied, never inferred. Focused tests cover signature/claim validation, async identity endpoint behavior, key rotation/cache, invalid endpoints, and provider outage.
- Added `createAuthenticatedMemorySession`, a request-scoped factory that accepts only a verifier-issued principal and derives tenant/actor scope from signed claims; fabricated principals and caller-supplied tenant/actor IDs are rejected. It is exported from the supported Core package API and has focused tests.
- The request-scoped factory is intentionally not installed as a singleton `CoreModule` memory capability: Core module contexts live for the module lifecycle, while authenticated users vary per request. A future HTTP workload must create a fresh session per authenticated request. The factory is not yet connected to a live user-facing memory route or PostgreSQL deployment.

### Agent and Tool Execution — disabled
Require explicit capability grants, per-action policy checks, least-privilege boundaries, timeouts, cancellation, quotas, idempotency, immutable audit, secret redaction, and sandboxing before any execution path is enabled. Agent remains OFF and Phase 0 remains NOT GRANTED. Do not connect real providers, credentials, financial operations, or external tools without dedicated review and separate owner authorization.

## Stage 6 — operational readiness (partial; not production-ready)
- `/health` liveness and `/ready` Core-lifecycle readiness endpoints are implemented and tested.
- Graceful shutdown and process-level signal/fatal-event tests are covered by CI.
- An operational runbook exists, but dependency-aware readiness, deployment resource limits, restart policy, rollback automation, load/soak/capacity evidence, and a tested incident/recovery procedure remain open.
- No production deployment is authorized or claimed.

## Merge governance and PR target

- Current implementation work is isolated in PR #61 (`fix/f01-f02-atomic-registration`) against `integration/infinyx-core-runtime-v1`.
- PR #61 must remain Draft and unmerged pending independent review and closure of all required gates.
- PR #60 remains untouched, Draft, and unmerged.
- No merge, auto-merge, release, deployment, or Agent activation is authorized by implementation progress or CI success. Each remains subject to separate explicit Founder authorization.
- Agent remains OFF; Phase 0 remains NOT GRANTED.

## Change and review protocol

For every stage:
1. Record base and head commit SHAs.
2. Work only on a dedicated branch.
3. Make small changes with focused regression tests.
4. Run all applicable checks and preserve actual results.
5. Obtain independent review of the exact head commit.
6. Record unresolved risks explicitly.
7. Stop before merge or deployment pending separate owner approval.


### Stage 6 progress — operational runbook (working draft)

- Added `docs/operations/core-engine-v1-runbook.md` against the current branch.
- The runbook records the actual Node/npm commands, environment configuration, startup
  ordering, current `/health` semantics, graceful HTTP/Core shutdown behavior, security
  limitations, and deployment/rollback gates.
- It records `/health` as liveness-only and `/ready` as Core-lifecycle readiness; neither checks downstream dependency health.
- It does not claim production readiness. Resource limits, restart policy, rollback automation, load/soak measurements, dependency-aware readiness, and external infrastructure remain unverified.
- Stage 6 remains **OPEN / draft pending independent review and owner approval**. This
  documentation change does not authorize deployment or release.


### Stage 6 progress — Core lifecycle readiness probe

- Added `GET /ready`, wired to the actual `CoreEngine.state` in the server composition.
- Returns HTTP 200 only while Core is `running`; returns HTTP 503 before readiness and
  after shutdown begins. `GET /health` remains a liveness-only endpoint.
- Added API regression coverage for starting, running and stopping states.
- This is not dependency-aware readiness and does not establish production readiness.
