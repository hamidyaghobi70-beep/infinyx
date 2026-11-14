# Protected Operation Shutdown and Correlation Contract

**Document ID:** INFINYX-ENG-002  
**Status:** Proposed design contract — not implementation authorization  
**Scope:** Core Runtime protected-operation admission, shutdown, and invocation correlation  
**Baseline:** `integration/infinyx-core-runtime-v1` at `683074174c140ee67620ee98ba5d55ecfbdef006`  
**Date:** 2026-11-14

## 1. Purpose

Define the lifecycle boundary between an admitted protected-operation handler and CoreEngine shutdown. The contract also distinguishes an operation definition from an individual invocation so that audit records can identify one execution unambiguously.

This document responds to the behavior demonstrated by the existing test that allows `CoreEngine.stop()` to resolve while an admitted handler remains active. It is a proposed design, not evidence that the implementation has changed.

## 2. Non-goals and safety boundaries

- This document does not authorize code changes, merge, release, deployment, or public exposure.
- It does not claim that an AbortSignal can forcibly terminate a handler. Cancellation is cooperative.
- It does not provide exactly-once execution, durable replay protection, or transactionality for external side effects.
- It does not authorize automatic retry or replay of an operation whose external outcome is unknown.
- It does not enable agents, tools, financial actions, or external side effects beyond the existing explicit protected-operation boundary.
- Durable audit integration remains a separate contract and must use the per-invocation identifier defined here.

## 3. Identity model

The runtime must distinguish these identifiers:

| Field | Meaning | Lifetime |
|---|---|---|
| `operationDefinitionId` | Stable registration identifier, such as `records.write` | Across all invocations of one registered definition |
| `operationId` | Unique identifier for one admitted invocation | One invocation, stable across its lifecycle and audit records |

Requirements:

1. Generate `operationId` once for each invocation, using a collision-resistant runtime UUID facility (for example, Node.js `crypto.randomUUID()`).
2. Never populate the invocation `operationId` with the registration ID.
3. Preserve the same `operationId` in handler context, lifecycle events, audit intent/outcome records, and reconciliation lookups for that invocation.
4. Do not regenerate the ID on cancellation, timeout, late settlement, or reconciliation.
5. A retry is a new invocation and must receive a new `operationId`; any relationship to an earlier attempt must be explicit metadata, not ID reuse.
6. Do not describe this identifier as a durable idempotency key unless a separate persistence-backed idempotency contract exists.

## 4. Admission boundary

The admission boundary is the synchronous point after a valid Allow decision and immediately before handler invocation.

1. Before admission, the operation is pending authorization and must not be counted as an active handler.
2. CoreEngine must reject new admissions as soon as shutdown begins.
3. The final lifecycle check, cancellation check, active-operation registration, and handler invocation must occur without an intervening `await`. This prevents shutdown from interleaving between the final check and registration in the single-threaded JavaScript execution turn.
4. The executor must register the active invocation before invoking user handler code.
5. A handler is considered admitted only after this registration succeeds.
6. A request denied before admission must never appear in the active-handler registry and must never invoke its handler.

The admission gate and active registry must be owned by the same runtime coordination boundary as CoreEngine lifecycle. A separate unsynchronized boolean in the executor is insufficient.

## 5. Required invocation states

The minimum observable lifecycle is:

| State | Meaning |
|---|---|
| `AUTHORIZING` | Policy evaluation is pending |
| `DENIED` | Authorization, validation, lifecycle, or cancellation prevented admission |
| `ADMITTED` | Handler has crossed the admission boundary and is tracked |
| `CANCELLATION_REQUESTED` | Caller, parent, or runtime shutdown requested cooperative cancellation |
| `SETTLED_SUCCEEDED` | Handler promise fulfilled |
| `SETTLED_FAILED` | Handler promise rejected or threw |
| `UNRESOLVED_AT_DEADLINE` | Shutdown drain deadline elapsed while the handler remained unsettled |

A timeout does not mean the handler was cancelled or that its external effects did not occur. A late settlement must update the same tracked invocation; it must not create a second invocation or silently erase the original outcome history.

## 6. Shutdown protocol

Shutdown must follow this order:

1. **Close admission:** synchronously transition CoreEngine out of `running`. From this point, no new protected-operation handler may be admitted.
2. **Close both execution paths synchronously:** invoke the executor's shutdown boundary to reject further admission and request cancellation of every already-admitted handler; also invoke policy-engine shutdown so pending authorization evaluations are stopped. Do not await one shutdown path before initiating the other. A policy result arriving after the lifecycle transition must not admit a handler.
3. **Preserve cancellation causes:** signal admitted handlers with a runtime-shutdown cancellation cause while retaining caller/parent cancellation provenance. The active handler must receive the same invocation signal and `operationId` established at admission.
4. **Drain concurrently:** await both policy shutdown completion and settlement of all admitted handlers. Handler draining begins at shutdown initiation, not after policy shutdown completes. Each wait must have an explicit bounded deadline; if either path remains unresolved, report an explicit unresolved/blocked shutdown outcome and do **not** begin module cleanup.
5. **Decide shutdown outcome:**
   - Continue to module cleanup only after policy shutdown has settled successfully and the admitted-handler registry is empty.
   - If policy shutdown fails or remains unresolved, or any handler remains unsettled at its deadline, preserve the unresolved state and do **not** begin module cleanup.
6. **Late settlement:** retain tracking for unresolved handlers. When they eventually settle, record the terminal handler outcome against the same `operationId`. A later explicit shutdown attempt may re-evaluate whether draining is complete; it must not re-run settled handlers.
7. **Cleanup:** only after policy shutdown has settled successfully and the active-handler registry is empty may module cleanup begin, in the existing dependent-first/reverse lifecycle order. This rule also applies when the engine has zero initialized modules; the no-module fast path must not bypass operation draining.

### 6.1 Why cleanup is blocked on unresolved handlers

A protected handler may still be using module-owned resources, memory, database clients, or other dependencies. Tearing those resources down while the handler is active can create races and uncertain side effects. Therefore a drain timeout is not permission to proceed with cleanup.

This is a fail-closed safety rule. Operational recovery for a permanently non-cooperative handler must be documented separately; it must not be disguised as successful graceful shutdown.

### 6.2 Required CoreEngine–executor coordination

The implementation must provide one lifecycle coordination boundary shared by `CoreEngine` and `ProtectedOperationExecutor`:

1. `CoreEngine.stop()` first changes lifecycle to `stopping`, which closes the existing admission predicate synchronously.
2. In the same synchronous start-of-stop turn, it invokes an executor shutdown method that synchronously marks the executor as closing and aborts the controllers of all registered admitted invocations. It must not wait for policy shutdown before doing this. The abort must carry a structured shutdown cause; caller and parent cancellation provenance must not be silently overwritten.
3. It also invokes `policy.shutdown()` synchronously in that start-of-stop turn. The returned promises are then observed concurrently; a rejection or deadline expiry is a shutdown failure/block, not permission to clean up.
4. Policy shutdown must distinguish **cancelling the wrapper's wait** from **settlement of the underlying evaluator**. An `AbortSignal` request or a `Promise.race` returning Deny does not prove the delegate evaluator has stopped. The policy wrapper must retain and track each in-flight delegate evaluation until it settles, unless the delegate exposes a separately documented shutdown guarantee that establishes termination. If an evaluator remains unresolved and may still use resources, policy shutdown is unresolved and module cleanup remains blocked.
5. The executor's active registry is populated before calling handler code and retains each invocation until its handler promise settles and terminal bookkeeping completes. Registering an invocation and calling the handler must not be separated by an `await`.
6. Pending policy evaluations are not active handlers. Their cancellation request and underlying evaluator settlement are tracked by the policy shutdown path; their late Allow results must fail the final lifecycle/admission check.
7. The engine must use the same drain-and-block rules even if `initializedModules` is empty.
8. The active registry must not expose mutable internal maps or controllers to modules. Diagnostics may expose immutable snapshots only.

This coordination requirement is necessary because the current `FailClosedPolicyEngine.shutdown()` stops policy intake, requests cancellation, and awaits the delegate's optional `shutdown()` method. However, `evaluate()` races its delegate promise against cancellation and removes its active stop callback when that race settles; this alone does not prove a non-cooperative delegate evaluation has settled. The current executor also has no registry or shutdown method for handlers that have already been admitted.

### 6.3 Public stop() result and stable error semantics

Preserve the existing public method shape, `stop(): Promise<void>`, for source compatibility in this stage. A shutdown that is blocked or unresolved must reject; it must never resolve successfully merely because a deadline elapsed.

Use stable, machine-readable `CoreError.code` values rather than requiring callers to parse error messages:

| Code | Meaning | Cleanup permitted? |
|---|---|---|
| `PROTECTED_OPERATION_DRAIN_TIMEOUT` | One or more admitted handlers remain unsettled at the handler-drain deadline | No |
| `POLICY_EVALUATION_DRAIN_TIMEOUT` | One or more underlying policy evaluations remain unsettled at the policy-drain deadline | No |
| `POLICY_SHUTDOWN_FAILED` | Policy shutdown rejects before the drain deadline | No |
| `MODULE_STOP_FAILED` | Existing module cleanup failure after safe cleanup was attempted | Cleanup has been attempted according to dependency rules |

Requirements:

1. Add the new codes to the existing `CoreErrorCode` union; preserve `MODULE_STOP_FAILED` for actual module cleanup failures rather than using it for every shutdown failure.
2. Keep the original underlying error as `cause` where one exists. Deadline errors must identify the failure category without exposing caller context, secrets, or mutable registry internals.
3. A handler's own rejected promise is an operation outcome, not by itself a shutdown failure. Once it has settled and terminal bookkeeping is complete, it may be removed from the active registry and safe cleanup may proceed.
4. A deadline rejection does not settle, discard, or replay the underlying handler/evaluator. It only ends that caller's bounded wait. The underlying work remains tracked.
5. Concurrent callers during one shutdown attempt share the same in-progress `stop()` promise. After a bounded attempt rejects, a later explicit `stop()` call may wait again on the same unresolved invocations; it must not re-invoke handlers or create duplicate invocation IDs.
6. The executor and policy wrapper shutdown boundaries must be idempotent. Repeated calls may request/observe the same cancellation and tracked work, but may not duplicate terminal bookkeeping or restart work.
7. Do not introduce a new successful return union in this compatibility stage. If a future API returns a structured shutdown report, that is a separately versioned compatibility decision.

### 6.4 Retryable shutdown-attempt lifecycle

A bounded shutdown attempt may reject while protected handlers or policy evaluators remain tracked. That rejection ends the current caller wait; it does not roll the CoreEngine lifecycle back to `running`, mark it `stopped`, or discard unresolved work.

Requirements:

1. Keep the engine in `stopping` after a drain timeout or policy-shutdown failure that leaves shutdown incomplete.
2. If a `stopPromise` is currently pending, every concurrent `stop()` caller receives that exact same promise.
3. If the previous attempt has settled by rejection and its shared promise has been cleared, a later explicit `stop()` call while lifecycle is `stopping` must be allowed to start a new bounded observation attempt. It must not reopen admission.
4. A new attempt must reuse the same executor invocation records and underlying policy-evaluation records. It must not invoke a handler again, create a new `operationId`, or reset a prior cancellation cause.
5. If all tracked handlers and policy evaluations have since settled successfully (and policy shutdown is confirmed complete), the later attempt may proceed to module cleanup. If work remains unresolved, it may wait until its configured deadline and reject again.
6. Policy shutdown must be idempotent and observable across attempts: an earlier rejected caller wait is not proof that the delegate shutdown or evaluator work has settled.
7. Only successful completion of all required drains and module cleanup may transition lifecycle to `stopped`. A failed module cleanup retains the existing explicit cleanup-retry rules and dependency protection.

This is a continuation of the same shutdown, not a second shutdown or operation replay.

## 7. Timeout and retry semantics

- The recommended model is one finite absolute deadline per drain attempt, measured with a monotonic clock. It bounds the concurrent barrier covering admitted-handler settlement, underlying policy-evaluation settlement, and delegate-shutdown observation; it does not terminate JavaScript execution.
- Handler and policy drain waits begin in the same synchronous start-of-stop turn and consume the same remaining budget. Do not add separate sequential timeout windows or restart the budget when one path settles.
- A policy shutdown rejection may fail the attempt immediately before the shared deadline. If the shared deadline expires while one or more paths remain unresolved, report all observed blockers using the deterministic primary-code precedence in section 11.1.
- When the drain deadline expires, the runtime reports shutdown as unresolved/blocked. It must not claim successful shutdown or begin module cleanup.
- The unresolved invocation/evaluation remains tracked until its underlying promise settles or the process terminates.
- A subsequent explicit shutdown attempt may wait for the same tracked work with a fresh wait deadline; it must not invoke a handler again, restart an evaluation, or regenerate an invocation ID.
- No automatic retry of the protected operation is permitted as part of shutdown recovery.
- The drain deadline does not bound the later module-cleanup phase. Until a separate cleanup timeout/recovery contract is accepted and implemented, do not describe the entire stop() operation as globally time-bounded.
- If a handler never settles, graceful shutdown cannot be declared complete. Any forceful process termination is an external operational decision and must be separately authorized and documented.

## 8. Concurrency and race requirements

1. Multiple concurrent `stop()` callers must observe the same in-progress shutdown attempt/promise, consistent with the existing shared-stop-promise contract.
2. New calls after admission closes must be denied without invoking policy or the handler where the existing lifecycle contract allows this early rejection.
3. An authorization result racing with shutdown must be denied if it has not crossed the admission boundary before shutdown closes admission.
4. An invocation admitted before shutdown closes admission must be present in the active registry and included in drain.
5. Handler settlement and registry removal must be coordinated so shutdown cannot observe an empty registry before settlement bookkeeping is complete.
6. Cleanup must not start between the last handler settlement and its removal from the registry.

## 9. Audit and observability requirements

For each invocation, observable records should include:

- `operationId` (per invocation);
- `operationDefinitionId` (registration identity);
- actor/caller identity under the existing privacy and data-minimization rules;
- admission timestamp and outcome;
- cancellation source/reason where applicable;
- drain deadline observation, if unresolved;
- final settlement timestamp and outcome, including late settlement.

Do not log raw secrets, private keys, credentials, or unrestricted caller context. Audit persistence must define its own commit/acknowledgement and reconciliation semantics. A log message alone is not proof of durable audit.

## 10. Required acceptance tests

The implementation is not acceptable without deterministic tests covering at least:

1. Two invocations of one definition receive different `operationId` values and the same `operationDefinitionId`.
2. One invocation retains the same ID across handler context, cancellation, settlement, and audit correlation.
3. A handler blocked on a controllable promise receives runtime-shutdown cancellation when `stop()` begins.
4. `stop()` does not resolve and module cleanup does not begin while that handler remains unsettled.
5. A cooperative handler settles after cancellation and cleanup begins only afterward.
6. A non-cooperative handler exceeds the drain deadline; shutdown reports unresolved/blocked and cleanup remains uncalled.
7. A non-cooperative handler that settles late is removed from tracking exactly once; a later explicit stop can proceed without re-invoking it.
8. A policy evaluation resolving Allow after shutdown begins cannot cross admission.
9. Concurrent stop callers share the same shutdown attempt.
10. Multiple active handlers are all signalled and all must settle before cleanup.
11. Handler rejection is recorded as failure and does not prevent safe cleanup once the handler has settled.
12. No automatic retry occurs after drain timeout.
13. If policy delegate shutdown is held on a controllable promise, runtime-shutdown cancellation is still requested from every admitted handler immediately; handler draining does not wait for policy shutdown to settle.
14. A policy evaluator that ignores its signal and whose delegate shutdown does not establish termination remains tracked as unresolved; `stop()` must not treat the wrapper's early Deny result as proof that the evaluator settled.
15. With zero initialized modules and one admitted handler, `stop()` still waits for handler settlement or reports unresolved/blocked; it must not take a no-module fast path to `stopped`.
16. Policy shutdown rejection or deadline expiry blocks module cleanup even when all handlers have settled.
17. A handler is not removed from the active registry until its settlement outcome and required terminal bookkeeping have completed.
18. Handler-drain deadline expiry rejects `stop()` with `CoreError.code === "PROTECTED_OPERATION_DRAIN_TIMEOUT"`; it does not resolve successfully or start cleanup.
19. Policy-evaluation drain deadline expiry rejects with `POLICY_EVALUATION_DRAIN_TIMEOUT`, while a policy shutdown rejection maps to `POLICY_SHUTDOWN_FAILED`; neither starts cleanup.
20. A later explicit `stop()` after a previously timed-out handler settles can complete cleanup without invoking the handler again or changing its `operationId`.
21. A settled handler rejection is recorded as the operation's failed outcome but does not by itself prevent safe cleanup; a later module cleanup failure remains `MODULE_STOP_FAILED`.
22. After a bounded stop attempt rejects with a drain timeout, lifecycle remains `stopping`; once the rejected shared promise is cleared, a later explicit `stop()` is accepted, shares no stale rejected promise, and re-observes the same tracked invocation without replay. Admission remains closed throughout.

23. Handler draining and underlying policy-evaluation/delegate-shutdown observation consume one shared monotonic deadline; sequentially resolving one path must not grant the other path a fresh budget within the same attempt.
24. Advancing or moving the wall clock while a drain attempt is pending does not extend or shorten the monotonic drain deadline.
25. When multiple blockers coexist at the shared deadline, the primary stable error code follows section 11.1 precedence and immutable sanitized details include every blocker observed at that deadline.
26. If delegate policy shutdown rejects while handlers remain active, the attempt rejects with the policy-shutdown failure, module cleanup remains blocked, and a later explicit attempt observes the same tracked work without replay or duplicate terminal bookkeeping.

27. A delegate shutdown rejection follows the architecture-approved recovery rule: a later explicit stop observation must neither silently re-invoke delegate shutdown nor claim completion without evidence that policy shutdown is complete.
Tests must use controlled promises/signals rather than relying on arbitrary sleeps.

## 11. API and compatibility decisions still required

Before implementation, architecture review must explicitly decide:

- Whether the handler context field is renamed from `operationId` to include both `operationId` and `operationDefinitionId`, and how compatibility is handled.
- The default and configurable drain deadline, and whether zero/unbounded values are prohibited.
- Whether a future major API should expose a structured shutdown report instead of the current `Promise<void>`; this stage preserves `Promise<void>` and uses stable `CoreError.code` rejections.
- The recommended relationship is one shared monotonic drain deadline, as detailed in section 11.1; Haniyeh must explicitly accept or amend this model before implementation. Neither handler nor policy drain may silently remain unbounded.
- How cancellation reasons are represented without relying on unsupported runtime-specific behavior, including precedence/provenance when caller, parent, and runtime shutdown cancellation race.
- Whether a policy delegate's `shutdown()` contract guarantees evaluator termination, or whether the wrapper must independently drain tracked delegate evaluations.
- What recovery semantics apply if the delegate's own `shutdown()` promise rejects: sticky terminal failure, a separately authorized idempotent retry, or another explicit recovery contract. A later `CoreEngine.stop()` observation must not silently re-invoke a potentially side-effecting delegate shutdown.
- How active-operation tracking is exposed to diagnostics without exposing mutable internal state.
- How a permanently non-cooperative handler is handled operationally without silently cleaning up its dependencies.

These are explicit design gates, not implementation details to guess. The retryable `stopping` lifecycle behavior in section 6.4 is a required compatibility correction because the current `stop()` lifecycle guard does not permit a new attempt once an earlier stop promise has rejected while the engine remains `stopping`.

### 11.1 Recommended architecture resolution package (pending Haniyeh acceptance)

The following is the recommended resolution of the open decisions above. It is a review proposal only; none of these choices is an implementation authorization.

1. **One absolute deadline per drain attempt:** start handler draining, policy-evaluation draining, and delegate shutdown observation in the same synchronous start-of-stop turn. Give each drain attempt one finite, configurable absolute deadline measured with a monotonic clock. This avoids accidentally adding sequential timeout windows. A later explicit stop attempt receives a fresh drain-wait deadline but observes the same underlying invocation/evaluation records. This deadline scope is limited as specified in item 9 below.
2. **Per-invocation identity:** use Node.js `crypto.randomUUID()` once at invocation admission. Keep `operationDefinitionId` separate and immutable. Treat retries as new invocations with new IDs; never reuse an ID to imply idempotency.
3. **Cancellation provenance:** record an immutable primary cancellation cause as the first accepted cause for an invocation. Preserve later causes (including runtime shutdown) as additional provenance events; do not overwrite the original cause or issue duplicate handler invocation. The shutdown coordinator independently records that runtime shutdown was requested even when the handler's signal had already been aborted by its caller or parent.
4. **Evaluator settlement proof:** retain the underlying delegate evaluation promise in a policy-owned active-evaluation registry until it actually settles. A delegate `shutdown()` may replace individual waiting only if its documented contract explicitly guarantees termination of all in-flight evaluations and a deterministic test proves that guarantee.
5. **Simultaneous blockers:** collect all drain blockers observed at the attempt deadline and expose a sanitized immutable blocker list in error details. Preserve the existing stable error codes; choose the primary code deterministically using this precedence when multiple blockers coexist: `POLICY_SHUTDOWN_FAILED`, then `POLICY_EVALUATION_DRAIN_TIMEOUT`, then `PROTECTED_OPERATION_DRAIN_TIMEOUT`. Keep the other blockers in details so callers do not mistake the primary code for the only unresolved path. Preserve the original cause for a policy shutdown failure.
6. **Retry and idempotency:** retries are explicit calls only. A retry observes the same unresolved work and same cancellation provenance; it never replays handlers, restarts evaluations, regenerates IDs, or resets the shutdown state.
7. **Diagnostics:** expose counts and immutable, privacy-minimized snapshots only. Do not expose mutable registries, AbortControllers, raw caller context, or secrets.

8. **Clock-domain compatibility:** use a monotonic clock (for example, `performance.now()`) as the authoritative clock for the shutdown drain deadline. Do not silently reinterpret the existing public `PolicyEvaluationOptions.deadlineAt`, which currently uses an epoch-style wall-clock value (`Date.now()`). If the existing policy delegate needs a deadline hint, derive a best-effort wall-clock deadline from the remaining monotonic budget at the call boundary; the Core shutdown coordinator's monotonic timer remains authoritative if the system clock changes. Any new monotonic deadline field must be internal or separately versioned and must have an explicit unit/clock-domain contract.
9. **Deadline scope and cleanup phase:** the shared absolute deadline above governs the concurrent protected-handler and policy-evaluation/delegate-shutdown drain barrier. It does not, by itself, prove that module cleanup is bounded. Module cleanup starts only after that barrier succeeds and needs a separately specified timeout/recovery contract if bounded cleanup is required. Until that contract exists, do not describe the entire `stop()` operation as globally time-bounded; describe only the drain barrier as bounded. Do not let a drain timeout overlap or trigger module cleanup.

**Architecture acceptance requested:** accept or amend each item above, especially the single-deadline model and deterministic simultaneous-blocker precedence, before runtime implementation begins.

## 12. Acceptance and promotion gates

- Haniyeh's architecture acceptance is required before implementation.
- Independent security/quality review is required for the shutdown race, cancellation, timeout, and audit-correlation design.
- Exact-head CI must pass on the intended base and required platforms after implementation.
- The PR remains Draft until the applicable review and evidence requirements are met.
- This document does not authorize merging PR #7, modifying `main`, releasing, or deploying.

## 13. Current evidence and disposition

The baseline implementation currently passes the existing test that demonstrates an admitted handler may remain active after `CoreEngine.stop()` resolves. The executor currently sets handler context `operationId` to the registration ID. These are observed baseline behaviors, not accepted production guarantees.

**Disposition:** Proposed contract for architecture and independent review. Implementation remains not authorized by this document.
