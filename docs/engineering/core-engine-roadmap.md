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

The current Core Engine defines a MemoryPort contract but does not provide a persistence adapter.

Before implementing an adapter, document and approve:
- Data classification and tenant isolation.
- Encryption at rest and in transit.
- Key ownership and rotation.
- Retention, deletion, and backup policy.
- Access-control enforcement and audit events.
- Failure behavior and migration strategy.

Implement storage behind the existing port only after these controls have testable acceptance criteria.

## Stage 5 — identity, agent runtime, and tool execution

These capabilities are not enabled by the reviewed Core Engine v1 scope.

Design provider-neutral interfaces first. Require:
- Authenticated principal and tenant context.
- Explicit capability grants and per-action policy checks.
- Least-privilege execution boundaries.
- Timeouts, cancellation, quotas, and idempotency.
- Immutable audit records and secret redaction.
- Sandboxed execution and denial-by-default behavior.

Do not connect real providers, credentials, financial operations, or external tools until their dedicated security review and owner authorization are complete.

## Stage 6 — operational readiness

After earlier stages pass:
- Define health/readiness semantics and structured operational events.
- Verify graceful shutdown under active HTTP requests and long-lived connections.
- Define resource limits, restart policy, and deployment rollback criteria.
- Produce an operations runbook and incident test plan.

Production deployment remains a separately authorized action.

## Merge governance and PR target

- PR #3 targets `fix/core-engine-shutdown-v6`; that is the intended integration base. It does not target `main`.
- Hanieh, as Project Leader, owns the readiness decision and issues the explicit instruction to merge a specific PR/head SHA after technical acceptance.
- Parvaneh performs GitHub operations only in response to Hanieh's explicit merge instruction for that specific PR/head SHA.
- Hamid, as Founder & Owner, separately authorizes each Release and each Deployment. Neither merge readiness nor a merge instruction authorizes either action.
- `main`, Release, and Deployment are outside the scope of the current PR #3 operation. No merge or deployment is to occur before Hanieh's final review and instruction.
- Agent and Tool Execution remain out of scope.

## Change and review protocol

For every stage:
1. Record base and head commit SHAs.
2. Work only on a dedicated branch.
3. Make small changes with focused regression tests.
4. Run all applicable checks and preserve actual results.
5. Obtain independent review of the exact head commit.
6. Record unresolved risks explicitly.
7. Stop before merge or deployment pending separate owner approval.
