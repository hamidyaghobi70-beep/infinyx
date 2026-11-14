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
4. The executor's active registry is populated before calling handler code and retains each invocation until its handler promise settles and terminal bookkeeping completes. Registering an invocation and calling the handler must not be separated by an `await`.
5. Pending policy evaluations are not active handlers. They are stopped by the policy shutdown path; their late Allow results must fail the final lifecycle/admission check.
6. The engine must use the same drain-and-block rules even if `initializedModules` is empty.
7. The active registry must not expose mutable internal maps or controllers to modules. Diagnostics may expose immutable snapshots only.

This coordination requirement is necessary because the current `FailClosedPolicyEngine.shutdown()` stops policy intake and requests cancellation of policy evaluations, while the current executor has no registry or shutdown method for handlers that have already been admitted.

## 7. Timeout and retry semantics

- The handler-drain deadline bounds how long one shutdown attempt waits for admitted handlers; it does not terminate JavaScript execution.
- The policy-shutdown deadline independently bounds the wait for policy shutdown completion. Architecture must define whether both deadlines share one absolute shutdown budget or have separate bounded budgets.
- When either deadline expires, the runtime reports that shutdown is unresolved/blocked. It must not claim successful shutdown.
- The unresolved invocation remains tracked until its promise settles or the process terminates.
- A subsequent explicit shutdown attempt may wait for the same invocation; it must not invoke the handler again.
- No automatic retry of the protected operation is permitted as part of shutdown recovery.
- If the handler never settles, graceful shutdown cannot be declared complete. Any forceful process termination is an external operational decision and must be separately authorized and documented.

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

Tests must use controlled promises/signals rather than relying on arbitrary sleeps.

## 11. API and compatibility decisions still required

Before implementation, architecture review must explicitly decide:

- Whether the handler context field is renamed from `operationId` to include both `operationId` and `operationDefinitionId`, and how compatibility is handled.
- The default and configurable drain deadline, and whether zero/unbounded values are prohibited.
- The public shape of a blocked/unresolved shutdown result (typed result versus rejected `stop()` promise and stable error code).
- The policy-shutdown deadline and its relationship to the protected-handler drain deadline; neither wait may silently remain unbounded.
- How cancellation reasons are represented without relying on unsupported runtime-specific behavior, including precedence/provenance when caller, parent, and runtime shutdown cancellation race.
- Whether a policy delegate's `shutdown()` contract guarantees evaluator termination, or whether the wrapper must independently drain tracked delegate evaluations.
- How active-operation tracking is exposed to diagnostics without exposing mutable internal state.
- How a permanently non-cooperative handler is handled operationally without silently cleaning up its dependencies.

These are explicit design gates, not implementation details to guess.

## 12. Acceptance and promotion gates

- Haniyeh's architecture acceptance is required before implementation.
- Independent security/quality review is required for the shutdown race, cancellation, timeout, and audit-correlation design.
- Exact-head CI must pass on the intended base and required platforms after implementation.
- The PR remains Draft until the applicable review and evidence requirements are met.
- This document does not authorize merging PR #7, modifying `main`, releasing, or deploying.

## 13. Current evidence and disposition

The baseline implementation currently passes the existing test that demonstrates an admitted handler may remain active after `CoreEngine.stop()` resolves. The executor currently sets handler context `operationId` to the registration ID. These are observed baseline behaviors, not accepted production guarantees.

**Disposition:** Proposed contract for architecture and independent review. Implementation remains not authorized by this document.
