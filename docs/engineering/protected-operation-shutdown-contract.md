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
5. A separately authorized re-invocation of the protected-operation handler is a new invocation and must receive a new `operationId`; a later explicit `CoreEngine.stop()` observation attempt is not a handler retry and must retain the original invocation ID. Any relationship between distinct handler invocations must be explicit metadata, not ID reuse.
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

1. `CoreEngine.stop()` first changes lifecycle to `stopping`, which independently closes the authoritative CoreEngine admission predicate synchronously. The final admission check immediately before handler invocation must consult this predicate, so a failure in the executor shutdown call cannot reopen admission or permit a late policy result to start a handler.
2. In the same synchronous start-of-stop turn, it attempts to invoke an executor shutdown method that synchronously marks the executor as closing and requests cancellation of all registered admitted invocations. The abort must carry a structured shutdown cause; caller and parent cancellation provenance must not be silently overwritten. The CoreEngine lifecycle gate is the admission safety boundary; the executor call is the cancellation/drain initiation boundary. If executor shutdown throws or only partially performs its work, do not assume every active handler received the shutdown signal: retain every invocation record, report `PROTECTED_OPERATION_SHUTDOWN_FAILED`, and keep module cleanup blocked until the initiation failure is resolved under the architecture-approved recovery rule and the required handler drain is independently proven complete.
3. It also attempts to invoke `policy.shutdown()` synchronously in that same start-of-stop turn, without awaiting the executor shutdown result. **Synchronous throws from either initiation call must be captured as that path's failed result and must not prevent the other initiation call from being attempted.** Normalize a synchronous throw into an observed rejected result for shutdown coordination; do not allow it to escape before both paths have been initiated/attempted. Observe both resulting promises concurrently. An initiation failure, asynchronous rejection, or deadline expiry is a shutdown failure/block, not permission to clean up.
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
| `PROTECTED_OPERATION_SHUTDOWN_FAILED` | Executor shutdown initiation throws or otherwise fails before handler cancellation/drain can be established | No |
| `POLICY_EVALUATION_DRAIN_TIMEOUT` | One or more underlying policy evaluations remain unsettled at the policy-drain deadline | No |
| `POLICY_SHUTDOWN_FAILED` | Policy shutdown initiation or delegate shutdown rejects before the drain deadline | No |
| `MODULE_STOP_FAILED` | Existing module cleanup failure after safe cleanup was attempted | Cleanup has been attempted according to dependency rules |

Requirements:

1. Add the new codes to the existing `CoreErrorCode` union, including `PROTECTED_OPERATION_SHUTDOWN_FAILED` for executor shutdown initiation failure; preserve `MODULE_STOP_FAILED` for actual module cleanup failures rather than using it for every shutdown failure.
2. Keep the original underlying error as `cause` where one exists. Deadline errors must identify the failure category without exposing caller context, secrets, or mutable registry internals.
3. A handler's own rejected promise is an operation outcome, not by itself a shutdown failure. Once it has settled and terminal bookkeeping is complete, it may be removed from the active registry and safe cleanup may proceed.
4. A deadline rejection does not settle, discard, or replay the underlying handler/evaluator. It only ends that caller's bounded wait. The underlying work remains tracked.
5. Concurrent callers during one shutdown attempt share the same in-progress `stop()` promise. After a drain-only attempt rejects with `DRAIN_PENDING` and no initiation failure has occurred, a later explicit `stop()` call may perform a new bounded observation wait over the same unresolved invocation/evaluation records. This observation must not repeat executor shutdown initiation, policy shutdown initiation, handler invocation, or evaluation start.
6. If executor shutdown initiation, policy shutdown initiation, or delegate shutdown initiation throws, rejects, or is known to have partially performed side effects, the coordinator must enter sticky `RECOVERY_REQUIRED`. Every later `stop()` call may inspect and report retained records but must not re-invoke the failed initiation. Only a separately reviewed and approved Recovery Contract may authorize a recovery action; the rules in section 11.2.2 are controlling.
7. Do not introduce a new successful return union in this compatibility stage. If a future API returns a structured shutdown report, that is a separately versioned compatibility decision.

### 6.4 Drain observation and sticky initiation failure

A bounded drain-observation attempt may reject while protected handlers or policy evaluators remain tracked. The coordinator must distinguish a drain-only timeout from a failed shutdown initiation; these states have different follow-up behavior.

Requirements:

1. Keep the engine in `stopping` after any drain timeout or shutdown failure. Admission must never reopen.
2. If a `stopPromise` is pending, every concurrent caller receives that exact same promise.
3. If a drain-only observation attempt rejects with `DRAIN_PENDING` and no executor, policy, or delegate shutdown initiation has failed, a later explicit `stop()` may start a fresh bounded observation wait over the same tracked work and a fresh deadline.
4. A fresh observation attempt must not re-invoke executor shutdown initiation, policy shutdown initiation, a delegate shutdown method, a handler, or an evaluator. It must not create a new `operationId`, reset cancellation provenance, or duplicate terminal bookkeeping.
5. If all required tracked work later settles and no sticky initiation-failure blocker exists, a later observation may establish `DRAIN_COMPLETED` and proceed to the separately governed cleanup decision.
6. If any executor, policy, or delegate shutdown initiation throws, rejects, or may have partially performed side effects, set sticky `RECOVERY_REQUIRED`. Later `stop()` calls must report that blocker and may inspect retained state only; they must not retry or re-invoke the failed initiation.
7. `RECOVERY_REQUIRED` cannot be cleared merely because visible handler/evaluator promises later settle. Clearing it or performing a retry requires a separate, explicitly reviewed and approved Recovery Contract that reconciles prior side effects and retained records.
8. Only successful completion of all required drains, absence of sticky recovery blockers, satisfaction of the final monotonic-deadline check, and successful module cleanup may transition lifecycle to `stopped`.
9. Existing explicit module-cleanup retry behavior is outside this drain/initiation rule and remains subject to its own dependency-protection contract.

A later drain observation is not a retry of shutdown initiation, a second shutdown, or an operation replay.

## 7. Timeout, observation, and recovery semantics

- Each drain observation uses one finite absolute deadline measured with a monotonic clock. It bounds the concurrent barrier covering admitted-handler settlement, child-activity settlement, underlying policy-evaluation settlement, and observation of already-initiated shutdown work; it does not terminate JavaScript execution.
- Handler and policy drain observation begin in the same synchronous start-of-stop turn and consume the same remaining budget. Do not add sequential timeout windows or restart the budget when one path settles.
- A policy or executor initiation failure/rejection is not a drain timeout. It sets sticky `RECOVERY_REQUIRED` under section 11.2.2; the failed initiation must not be repeated by a later `stop()` call.
- When the drain deadline expires without an initiation failure, report the state as `DRAIN_PENDING`. A later explicit `stop()` may observe the same tracked work with a fresh observation deadline, but must not repeat any shutdown initiation, handler invocation, or evaluation.
- If the shared deadline expires while one or more paths remain unresolved, report all observed blockers using the deterministic primary-code precedence in section 11.2.10.
- When the drain deadline expires, the runtime reports shutdown as unresolved/blocked. It must not claim successful shutdown or begin module cleanup.
- The unresolved invocation/evaluation and registered child activities remain tracked until their underlying work settles or the process terminates.
- No automatic retry of the protected operation, executor shutdown initiation, policy shutdown initiation, or delegate shutdown initiation is permitted. A future recovery action requires a separate, reviewed and approved Recovery Contract.
- The drain deadline does not bound the later module-cleanup phase. Until a separate cleanup timeout/recovery contract is accepted and implemented, do not describe the entire `stop()` operation as globally time-bounded.
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
25. When multiple blockers coexist at the shared deadline, the primary stable error code follows section 11.2.10 precedence and immutable sanitized details include every blocker observed at that deadline.
26. If delegate policy shutdown rejects while handlers remain active, the attempt rejects with the policy-shutdown failure, module cleanup remains blocked, and a later explicit attempt observes the same tracked work without replay or duplicate terminal bookkeeping.

27. A delegate shutdown rejection sets `RECOVERY_REQUIRED`; later explicit stop observation must not re-invoke delegate shutdown, and settlement of visible evaluator promises alone must not clear the sticky blocker.
28. If executor shutdown initiation throws synchronously, policy shutdown is still attempted in the same start-of-stop turn; if policy shutdown initiation throws synchronously, executor admission is still closed and every admitted handler receives its shutdown cancellation request. Both synchronous failures are captured as shutdown blockers; neither permits module cleanup.
29. If executor shutdown initiation throws synchronously, policy shutdown is still attempted and the executor-initiation failure is surfaced as `PROTECTED_OPERATION_SHUTDOWN_FAILED`. Policy-path success alone does not resolve the executor failure or permit module cleanup; cleanup remains blocked by sticky `RECOVERY_REQUIRED` until a separately approved Recovery Contract resolves it and every admitted handler is independently proven settled. If both paths fail, primary error selection follows section 11.2.10.
30. If executor shutdown throws after partially closing or signalling its active registry, CoreEngine admission nevertheless remains closed by the independent lifecycle predicate; the contract does not assume all active handlers received cancellation and retains all invocation records. Cleanup remains blocked by sticky `RECOVERY_REQUIRED` until a separately approved Recovery Contract resolves the failure and every admitted handler is independently proven settled. A deterministic test must cover partial cancellation delivery followed by the executor initiation failure.
31. If executor shutdown initiation fails after partial side effects, a later explicit stop observation must not repeat initiation and must continue reporting `RECOVERY_REQUIRED`. No idempotent retry is permitted unless a separately approved Recovery Contract explicitly authorizes it and proves no duplicated side effects, lost invocation records, or duplicate terminal bookkeeping.
32. Omitted `protectedOperationShutdown.drainDeadlineMs` selects the documented provisional default exactly once; diagnostics identify that the value came from the default.
33. A valid explicit integer override at the minimum accepted value (1 ms) is accepted and becomes the effective value.
34. A valid explicit integer override at the maximum accepted value (2,147,483,647 ms) is accepted without timer overflow or coercion.
35. A valid explicit interior override is accepted unchanged and is reported accurately in sanitized diagnostics.
36. Zero is rejected before the engine enters `running`; no admission opens and no unbounded fallback is selected.
37. A negative value is rejected before the engine enters `running`; no admission opens.
38. A fractional numeric value is rejected rather than rounded, truncated, or coerced.
39. `NaN` is rejected before the engine enters `running`.
40. Positive and negative `Infinity` are rejected before the engine enters `running`.
41. Explicit `null` is rejected and is not treated as omission or as permission to use an unbounded deadline.
42. Values below the minimum or above the maximum are rejected before the engine enters `running`.
43. String, boolean, object, and other non-number values are rejected rather than implicitly coerced.
44. Omitted value and explicit invalid value are distinguished: only omission may select the provisional default.
45. Every invalid configuration produces the stable configuration error, leaves lifecycle outside `running`, keeps admission closed, and does not silently substitute another value.
46. The effective validated duration and its source (default or explicit override) appear in sanitized diagnostics without exposing secrets or caller data.
47. Reconfiguration after the engine enters `running` cannot mutate the active attempt's absolute deadline; any supported runtime reconfiguration requires a separately specified contract.
Tests must use controlled promises/signals rather than relying on arbitrary sleeps.

## 11. Historical architecture decision log (superseded)

> **Historical record only:** Sections 11 and 11.1 preserve the decision history from earlier review rounds. They are not open decisions and are not normative where they conflict with section 11.2. The current binding contract is section 11.2 and its amendments. Do not use historical wording below to reopen a decision already resolved in section 11.2.

Before implementation, architecture review must explicitly decide:

- Whether the handler context field is renamed from `operationId` to include both `operationId` and `operationDefinitionId`, and how compatibility is handled.
- The default and configurable drain deadline, and whether zero/unbounded values are prohibited.
- Whether a future major API should expose a structured shutdown report instead of the current `Promise<void>`; this stage preserves `Promise<void>` and uses stable `CoreError.code` rejections.
- The recommended relationship is one shared monotonic drain deadline, as detailed in section 11.1; Haniyeh must explicitly accept or amend this model before implementation. Neither handler nor policy drain may silently remain unbounded.
- How cancellation reasons are represented without relying on unsupported runtime-specific behavior, including precedence/provenance when caller, parent, and runtime shutdown cancellation race.
- Whether a policy delegate's `shutdown()` contract guarantees evaluator termination, or whether the wrapper must independently drain tracked delegate evaluations.
- What recovery semantics apply if the delegate's own `shutdown()` promise rejects: sticky terminal failure, a separately authorized idempotent retry, or another explicit recovery contract. A later `CoreEngine.stop()` observation must not silently re-invoke a potentially side-effecting delegate shutdown.
- What recovery semantics apply if executor shutdown initiation throws or partially signals handlers: sticky terminal failure, or a separately authorized idempotent retry that re-observes the same active registry without duplicate cancellation bookkeeping. A later `CoreEngine.stop()` observation must not silently repeat a potentially partially side-effecting executor shutdown unless that retry contract is explicitly accepted.
- How active-operation tracking is exposed to diagnostics without exposing mutable internal state.
- How a permanently non-cooperative handler is handled operationally without silently cleaning up its dependencies.

These are explicit design gates, not implementation details to guess. The retryable `stopping` lifecycle behavior in section 6.4 is a required compatibility correction because the current `stop()` lifecycle guard does not permit a new attempt once an earlier stop promise has rejected while the engine remains `stopping`.

### 11.1 Historical recommendation package (superseded by section 11.2)

This subsection is retained solely as a historical record of the recommendation package before the subsequent architecture decisions. It is superseded by section 11.2; its references to pending decisions or recommendations must not be treated as current open questions or normative requirements.

1. **One absolute deadline per drain attempt:** start handler draining, policy-evaluation draining, and delegate shutdown observation in the same synchronous start-of-stop turn. Give each drain attempt one finite, configurable absolute deadline measured with a monotonic clock. This avoids accidentally adding sequential timeout windows. A later explicit stop attempt receives a fresh drain-wait deadline but observes the same underlying invocation/evaluation records. This deadline scope is limited as specified in item 9 below.
2. **Per-invocation identity:** use Node.js `crypto.randomUUID()` once at invocation admission. Keep `operationDefinitionId` separate and immutable. A separately authorized re-invocation of the protected operation is a new invocation and receives a new ID; by contrast, a later explicit shutdown-observation attempt is not a new operation and must retain the same tracked invocation ID. Never reuse an ID to imply idempotency.
3. **Cancellation provenance:** record an immutable primary cancellation cause as the first accepted cause for an invocation. Preserve later causes (including runtime shutdown) as additional provenance events; do not overwrite the original cause or issue duplicate handler invocation. The shutdown coordinator independently records that runtime shutdown was requested even when the handler's signal had already been aborted by its caller or parent.
4. **Evaluator settlement proof:** retain the underlying delegate evaluation promise in a policy-owned active-evaluation registry until it actually settles. A delegate `shutdown()` may replace individual waiting only if its documented contract explicitly guarantees termination of all in-flight evaluations and a deterministic test proves that guarantee.
5. **Simultaneous blockers:** collect all drain blockers observed at the attempt deadline and expose a sanitized immutable blocker list in error details. Preserve the existing stable error codes; choose the primary code deterministically using this precedence when multiple blockers coexist: `POLICY_SHUTDOWN_FAILED`, then `PROTECTED_OPERATION_SHUTDOWN_FAILED`, then `POLICY_EVALUATION_DRAIN_TIMEOUT`, then `PROTECTED_OPERATION_DRAIN_TIMEOUT`. Keep the other blockers in details so callers do not mistake the primary code for the only unresolved path. Preserve the original cause for a policy shutdown failure.
6. **Retry and idempotency:** retries are explicit calls only. A retry observes the same unresolved work and same cancellation provenance; it never replays handlers, restarts evaluations, regenerates IDs, or resets the shutdown state.
7. **Diagnostics:** expose counts and immutable, privacy-minimized snapshots only. Do not expose mutable registries, AbortControllers, raw caller context, or secrets.

8. **Clock-domain compatibility:** use a monotonic clock (for example, `performance.now()`) as the authoritative clock for the shutdown drain deadline. Do not silently reinterpret the existing public `PolicyEvaluationOptions.deadlineAt`, which currently uses an epoch-style wall-clock value (`Date.now()`). If the existing policy delegate needs a deadline hint, derive a best-effort wall-clock deadline from the remaining monotonic budget at the call boundary; the Core shutdown coordinator's monotonic timer remains authoritative if the system clock changes. Any new monotonic deadline field must be internal or separately versioned and must have an explicit unit/clock-domain contract.
9. **Deadline scope and cleanup phase:** the shared absolute deadline above governs the concurrent protected-handler and policy-evaluation/delegate-shutdown drain barrier. It does not, by itself, prove that module cleanup is bounded. Module cleanup starts only after that barrier succeeds and needs a separately specified timeout/recovery contract if bounded cleanup is required. Until that contract exists, do not describe the entire `stop()` operation as globally time-bounded; describe only the drain barrier as bounded. Do not let a drain timeout overlap or trigger module cleanup.

**Historical status:** this request was superseded by the later ACCEPT WITH CONDITIONS review and the normative amendments in section 11.2. The precedence rule is reaffirmed in section 11.2.10.

## 12. Acceptance and promotion gates

- Haniyeh's architecture acceptance is required before implementation.
- Independent security/quality review is required for the shutdown race, cancellation, timeout, and audit-correlation design.
- Exact-head CI must pass on the intended base and required platforms after implementation.
- The PR remains Draft until the applicable review and evidence requirements are met.
- This document does not authorize merging PR #7, modifying `main`, releasing, or deploying.

## 13. Current evidence and disposition

The baseline implementation currently passes the existing test that demonstrates an admitted handler may remain active after `CoreEngine.stop()` resolves. The executor currently sets handler context `operationId` to the registration ID. These are observed baseline behaviors, not accepted production guarantees.

**Disposition:** Proposed contract for architecture and independent review. Implementation remains not authorized by this document.

## 11.2 Mandatory resolution of the 2026-11-14 architecture review

This section records the mandatory amendments from the final INFINYX-ENG-002 architecture review. It is normative and supersedes any earlier wording in this document that leaves these points open or suggests a weaker guarantee. It remains a documentation proposal; it does not authorize implementation.

### 11.2.1 Ownership and proof of asynchronous activity termination

1. **Handler promise ownership:** the promise returned by an admitted handler is the completion boundary for every asynchronous activity that the handler starts and that may access Runtime-owned resources or affect the operation's outcome. The handler must not return or fulfill while such dependent activity remains active.
2. **No untracked detached work:** fire-and-forget or otherwise detached asynchronous work that can use Runtime-owned resources, perform operation side effects, or affect the handler's outcome is prohibited. A handler that needs child tasks must either await all of them before its returned promise settles, or register each task with the Runtime-owned child-activity registry before it can outlive the handler's own control flow.
3. **Child registry:** separately registered child tasks must have stable per-task identity, explicit parent invocation identity, cancellation provenance, settlement tracking, and terminal bookkeeping. Registration must occur before the task can become detached. The shutdown drain barrier includes every registered child task and must not treat the parent handler as drained while any dependent child remains unsettled.
4. **Policy parity:** the same ownership rule applies to Policy Evaluators and their delegates. A policy evaluation's tracked completion must represent all asynchronous work it starts that may access policy/runtime resources. Detached delegate work is prohibited unless registered in a policy-owned dependent-activity registry and included in policy drain.
5. **Termination proof:** a handler or evaluator promise settling proves completion only when the applicable ownership rule guarantees that no unregistered dependent activity remains. An AbortSignal, wrapper Promise.race result, callback removal, or delegate shutdown acknowledgement without an explicit termination guarantee is not such proof.
6. **Resource eligibility:** the policy drain is complete only when all underlying evaluations and their registered dependent activities have settled, or an explicitly accepted delegate guarantee proves their termination. The protected-operation drain is complete only when all admitted handlers and their registered dependent activities have settled and terminal bookkeeping is complete.

### 11.2.2 Explicit initiation-failure and recovery policy

The current contract adopts a fail-closed, sticky recovery policy for this stage:

1. The coordinator distinguishes these observable states: `INITIATION_FAILED`, `DRAIN_PENDING`, `DRAIN_COMPLETED`, `RECOVERY_REQUIRED`, and `CLEANUP_ELIGIBLE`. These are shutdown-coordination states, not substitutes for the CoreEngine lifecycle states.
2. If executor shutdown initiation throws or partially performs side effects, record `INITIATION_FAILED` and `RECOVERY_REQUIRED`. Retain all invocation and child-activity records. Do not assume cancellation reached every handler.
3. If policy shutdown initiation or delegate shutdown fails, record the corresponding initiation/shutdown failure and `RECOVERY_REQUIRED`. Retain all underlying evaluator and child-activity records. Do not infer evaluator termination from a wrapper result or partial delegate effects.
4. **No automatic or implicit re-invocation** of executor shutdown initiation or policy/delegate shutdown is permitted after an initiation failure or rejection in this stage. A later `CoreEngine.stop()` call may observe already tracked work and report its state, but must not repeat a potentially side-effecting initiation.
5. A retry of either failed initiation is prohibited until a separate, explicit Recovery Contract is approved. That contract must identify the prior side-effect state, establish an idempotency or safe-resumption guarantee, define how partial cancellation/termination is reconciled, and include deterministic tests proving no duplicated side effects, lost records, or duplicate terminal bookkeeping.
6. Until that Recovery Contract exists and is accepted, `RECOVERY_REQUIRED` is a sticky blocker: admission remains closed, cleanup remains prohibited, and `stop(): Promise<void>` must reject with the appropriate stable `CoreError.code`. The coordinator must not convert this state into success merely because currently visible handler/evaluator promises have settled.
7. A drain timeout without an initiation failure remains `DRAIN_PENDING`; later explicit observation may use a fresh wait deadline over the same tracked records. It must never reopen admission, replay a handler, restart an evaluation, or reset cancellation provenance.
8. `DRAIN_COMPLETED` is reachable only after every required handler, evaluator, and registered dependent activity is proven settled and all required terminal bookkeeping has completed. `CLEANUP_ELIGIBLE` is reachable only after that condition holds, no sticky `RECOVERY_REQUIRED` blocker exists, and the final monotonic-deadline check below passes.

This policy intentionally chooses sticky failure over an assumed retry. Any future retry capability requires the separate Recovery Contract; it is not implied by this document.

### 11.2.3 Monotonic deadline enforcement at the cleanup decision

1. Each drain attempt has one finite absolute monotonic deadline. Handler, child-task, policy-evaluator, and delegate-shutdown observation share that same deadline and begin in the same synchronous shutdown-start turn.
2. The implementation must compare the current monotonic clock with the absolute deadline at the actual cleanup-eligibility decision, immediately before any module cleanup is invoked. It must not rely solely on a timeout callback or timer promise to indicate that the deadline has or has not elapsed.
3. If the event loop delays the timeout callback and the monotonic deadline has already elapsed, the attempt is expired even if the timer callback has not run. No cleanup may begin on the basis of late timer delivery.
4. If all work settles after the absolute deadline but before a delayed timeout callback executes, the final monotonic check still rejects the attempt as expired. A later explicit observation attempt may use a fresh deadline over the same settled records, subject to the sticky initiation-failure rule.
5. The deadline bounds the drain barrier only. It does not create a timeout guarantee for module cleanup.

### 11.2.4 Cancellation competition and provenance

1. Caller, parent, and Runtime-shutdown cancellation are competing causes, not separate handler invocations.
2. Preserve the first accepted cause as the immutable primary cause for the invocation. Record each later distinct cause as an additional provenance event, including Runtime shutdown even if the signal was already aborted.
3. Do not overwrite the primary cause, create a replacement signal that loses earlier provenance, or deliver duplicate terminal bookkeeping when another cancellation source arrives.
4. The deterministic test contract must control the order of cancellation-source arrival and assert the primary cause, complete provenance set, and single terminal outcome.

### 11.2.5 API compatibility and migration contract

1. Preserve the public method signature exactly as `stop(): Promise<void>` in this compatibility stage. Successful completion resolves with `void`; timeout, unresolved drain, initiation failure, recovery-required state, and module cleanup failure reject.
2. Preserve the source-level field name `operationId`, but define its meaning as the unique identifier of one invocation. Do not rename or remove it in this stage.
3. Add the independent `operationDefinitionId` field for the stable registered definition identity. Both fields must be present in the new invocation context and relevant audit/lifecycle records.
4. This is a semantic correction for consumers that previously interpreted `operationId` as the registration/definition identifier. Such consumers must migrate definition-level lookups and grouping to `operationDefinitionId`; invocation-level correlation continues to use `operationId`.
5. Document the migration as a compatibility note: the field name remains source-compatible, but its value semantics change. Consumers must not assume old persisted registration IDs in `operationId` are invocation IDs. Historical records require version-aware interpretation or an explicit data migration; the Runtime must not silently relabel old records.
6. Shutdown errors remain observable through stable `CoreError.code` values. Consumers must branch on codes rather than parsing messages. The method must never resolve successfully on timeout or drain failure.
7. Do not introduce a return union or rename `operationId` as part of this change. Any future structured shutdown result or breaking identifier rename requires a separately versioned API decision.

### 11.2.6 Additional deterministic acceptance tests

The original 31 cases remain proposed acceptance criteria and are not evidence of executed tests. Add cases 48–51 below; deadline-configuration cases 32–47 are specified in section 10:

32. **Handler child activity, capability mediation, and detached-work boundary:** use controllable parent and child promises. Prove that Runtime-resource capabilities register child activity before scheduling it; prove that a registered child remains in the drain registry after parent control flow ends; prove cleanup is blocked until the child settles and bookkeeping completes; and prove an unregistered child cannot obtain a Runtime-owned resource through the supported capability API. Also test and document the same-process ambient-API limitation described in section 11.2.8; do not represent a lint rule or adapter contract as a security sandbox.
33. **Event-loop delay and absolute deadline:** use an injected monotonic clock and controllable scheduler rather than arbitrary sleeps. Advance the monotonic clock beyond the absolute deadline while delaying timer callback delivery; prove the final cleanup decision rejects and cleanup is not invoked. Also prove wall-clock changes do not affect the monotonic deadline.
34. **Competing cancellation sources:** control caller, parent, and Runtime-shutdown cancellation arrival order. Assert that the first accepted cause remains immutable primary cause, later causes are preserved as provenance, all expected cancellation requests are observable, and handler invocation/terminal bookkeeping occurs exactly once.
35. **Partial initiation failure and recovery gate:** simulate executor and policy/delegate shutdown initiation failures after partial side effects. Assert that state becomes `INITIATION_FAILED` and `RECOVERY_REQUIRED`, admission remains closed, all invocation/evaluator/child records remain tracked, cleanup is blocked, and later `stop()` observation does not re-invoke either initiation. Assert that only a separately approved Recovery Contract can authorize a retry and that such retry tests must prove no duplicated side effects or lost records.

All 51 cases must use controllable promises, signals, an injected monotonic clock, and a deterministic scheduler as appropriate. No arbitrary sleeps are acceptable. These cases are specification-only until implemented and executed on a separately authorized implementation branch.

### 11.2.7 Updated disposition

**NOT READY FOR IMPLEMENTATION.** The ACCEPT WITH CONDITIONS review findings ENG002-R08, ENG002-R09, and ENG002-R10 have been addressed as proposed normative amendments. This exact revision still requires fresh architecture review and independent security/quality review. The provisional 30,000 ms default must be validated against representative load-test evidence before implementation acceptance. Passing documentation-branch CI is repository workflow evidence only; it is not proof that runtime behavior implements this contract.

Implementation, source-code changes, executable-test changes, merge, release, deployment, and changes to `main` remain unauthorized.


### 11.2.8 ENG002-R08 — Enforceable child-activity ownership and detached-work boundary

1. **Runtime Resource Capability Broker:** handlers and Policy Evaluators must receive Runtime-owned resource access only through explicit, scoped capability interfaces supplied by the Runtime. Do not pass raw database clients, filesystem handles, sockets, module-owned resource objects, or unrestricted service containers into handler/evaluator context.
2. **Register-before-start:** every capability that can create asynchronous work must register a child-activity record with the owning invocation/evaluation registry before scheduling or invoking that work. The record includes a stable child ID, parent invocation/evaluation ID, capability identity, cancellation provenance, and settlement state. If registration fails, the capability must fail without starting the activity.
3. **Tracked settlement:** the child record remains in the registry until the underlying activity settles and terminal bookkeeping completes. A timeout or abort request does not remove it. Parent completion does not imply child completion. The drain barrier includes all registered children.
4. **Capability closure:** capabilities are scoped to the parent invocation/evaluation and become unavailable for creating new work when admission closes or the parent is terminal. Existing registered work remains tracked until actual settlement. Capability APIs must not expose mutable registry internals or permit callers to mark work settled.
5. **Policy parity:** Policy Evaluators and delegates use the same broker/registry pattern for every Runtime-owned resource or asynchronous activity that can affect policy results or access resources needed during shutdown.
6. **No raw-resource escape:** adapters must not return raw resource handles or unrestricted callbacks that permit work to bypass registration. Any supported operation that can outlive the call must itself be represented as a registered child activity.
7. **Honest isolation boundary:** capability mediation is enforceable only for resources that the Runtime controls and exposes exclusively through those capabilities. Ordinary JavaScript executing in the same Node.js process may still access ambient APIs, import modules, use globals, or create unmanaged external work. A Worker thread alone is not a security sandbox. Therefore this contract does **not** claim that an in-process adapter can technically prevent arbitrary or malicious code from using ambient APIs.
8. **Trust profile:** Stage 1 may use in-process handlers/delegates only as trusted code subject to the capability contract and code-review controls. If handlers or delegates are untrusted or adversarial, they must not execute in the trusted Runtime process; implementation requires a separately reviewed process/container isolation profile with OS-level resource restrictions and an allowlisted IPC capability gateway. If that isolation profile is absent, untrusted execution is prohibited.
9. **Fail-closed conformance:** a handler/delegate adapter that cannot provide the required capability mediation and child registry semantics must not be admitted as conforming to this contract. No test harness, lint rule, TypeScript type, or documentation statement may be described as runtime containment by itself.

This section defines the required control boundary without overstating what same-process JavaScript can guarantee. It does not authorize implementation of a sandbox or process-isolation subsystem.

### 11.2.9 ENG002-R09 — Deadline configuration contract

1. The configuration key is `protectedOperationShutdown.drainDeadlineMs`; its unit is integer milliseconds. It configures the single shared drain barrier only, not module cleanup.
2. The proposed default is **30,000 ms** when the setting is omitted. This is a provisional baseline value, not a claim derived from production telemetry. Before implementation acceptance, the value must be validated against representative load tests and documented shutdown-latency objectives; evidence may justify changing the default.
3. The accepted numeric range is a finite safe integer from **1 through 2,147,483,647 ms**, inclusive. The upper bound avoids timer-range overflow in the Node.js timer model. Zero, negative values, fractional values, NaN, Infinity, null, and an unbounded/disabled setting are invalid.
4. The coordinator converts the configured duration into one absolute deadline using the monotonic clock (for example, `performance.now()`). All handler, child-activity, policy-evaluator, and delegate-shutdown waits share that absolute deadline. Wall-clock timestamps and the existing epoch-based `PolicyEvaluationOptions.deadlineAt` are not substitutes for this clock domain.
5. Configuration is validated before the engine enters `running`. Invalid or out-of-range configuration fails closed: startup is rejected with a stable configuration error, no protected-operation admission is opened, and no fallback to an unbounded wait or silent default is permitted.
6. An explicit valid override replaces the default for that runtime profile. The effective value and configuration source must be included in sanitized diagnostics, without exposing secrets or caller data.
7. The 30,000 ms default remains provisional until load-test evidence and the shutdown-latency objective are recorded in the implementation proposal. Changing the default later requires updating this contract and its deterministic configuration tests.


### 11.2.10 ENG002-R10 — Normative precedence and document authority

1. Section 11 and section 11.1 are historical decision records only. They preserve earlier proposals and review questions; they are not active decision gates.
2. Section 11.2, including sections 11.2.1 through 11.2.13, is the current normative proposal. Where historical wording conflicts with it, section 11.2 controls.
3. The primary shutdown error precedence is: `POLICY_SHUTDOWN_FAILED`, then `PROTECTED_OPERATION_SHUTDOWN_FAILED`, then `POLICY_EVALUATION_DRAIN_TIMEOUT`, then `PROTECTED_OPERATION_DRAIN_TIMEOUT`. Every concurrently observed blocker must still be retained in sanitized immutable error details.
4. The Recovery policy is sticky `RECOVERY_REQUIRED`; no implicit re-invocation is permitted. A retry can be authorized only by a separately reviewed and approved Recovery Contract.
5. The 51 acceptance cases are proposed specification criteria, not evidence of implementation or executed tests. Cases 27–31 cover sticky recovery; cases 32–47 cover deadline configuration; cases 48–51 cover capability, deadline scheduling, cancellation competition, and partial initiation failure.
6. References elsewhere in this document to pending decisions, recommended resolutions, or the former architecture-acceptance request are historical only and must not override the current decisions recorded in section 11.2.


### 11.2.11 ENG002-R11 — Unambiguous sticky recovery and observation-only stop calls

1. Sections 6.3, 6.4, and 7 are active requirements and must be read consistently with the sticky recovery policy in section 11.2.2.
2. A drain-only timeout with no initiation failure is `DRAIN_PENDING`. A later explicit `stop()` may start a new bounded observation wait over the same retained records. This is observation only: it must not repeat executor shutdown initiation, policy shutdown initiation, delegate shutdown, handler invocation, or evaluator start.
3. Any executor shutdown initiation throw, policy shutdown initiation throw/rejection, delegate shutdown throw/rejection, or known partial initiation side effect sets sticky `RECOVERY_REQUIRED`. Later `stop()` calls may inspect and report retained state only; they must not retry the failed initiation.
4. A sticky `RECOVERY_REQUIRED` blocker cannot be cleared by promise settlement alone. No cleanup is eligible while it remains. A recovery action or retry requires a separate explicit Recovery Contract approved through the project's architecture and security review gates.
5. The terms “retry,” “later attempt,” and “subsequent stop” in active sections refer only to bounded observation of already-initiated work unless an approved Recovery Contract explicitly authorizes a distinct recovery action. They never imply implicit re-invocation.
6. Acceptance cases 27–31 test sticky recovery and non-reinvocation; they remain specification criteria until separately authorized implementation and execution.

### 11.2.12 ENG002-R12 — Deterministic deadline-configuration acceptance matrix

1. The proposed acceptance suite independently covers: omitted setting/default selection; valid explicit overrides; minimum and maximum accepted integers; zero; negative; fractional; `NaN`; positive and negative `Infinity`; `null`; below-range and above-range numbers; non-number types; and distinction between omission and explicit invalid input.
2. Every invalid value must be rejected before CoreEngine enters `running`, leave admission closed, return the stable configuration error, and never fall back to an unbounded wait or silently substitute the default.
3. The effective validated duration and whether it came from the default or an explicit override must be visible in sanitized diagnostics.
4. The expanded configuration cases are acceptance cases 32–47 in section 10. They are required design criteria, not evidence that tests have been implemented or executed.
5. Tests must use deterministic typed inputs and must not rely on JSON serialization for values such as `NaN`, infinities, or `undefined`.

### 11.2.13 ENG002-R13 — Evidence plan for the provisional drain-deadline default

1. The 30,000 ms value remains a provisional candidate only. It is not an evidence-backed production default and must not be described as validated until the evidence below is collected and reviewed.
2. Before implementation acceptance, the implementation proposal must define representative workload profiles, including at minimum: no active operations; typical concurrent handler load; high but supported concurrency; handlers with registered child activities; policy evaluations with realistic delegate latency; cooperative cancellation; and controlled slow/unresolved work.
3. For each profile, record sample size, runtime and host configuration, concurrency, handler/evaluator/child settlement distributions, shutdown drain latency, timeout frequency, event-loop delay, and observed blocker/error codes. Record warm/cold conditions where they materially affect results.
4. Before running the benchmark, the product/operations owner must document the shutdown-latency objective and acceptable timeout/error budget for each relevant profile. Do not invent target percentiles or claim that a percentile is acceptable without that prior decision.
5. Evaluate the 30,000 ms candidate against the predeclared objectives and representative measurements. Retain it only if the evidence meets those objectives without unsafe cleanup, hidden untracked work, or excessive unresolved shutdowns; otherwise propose a revised value and rerun the same reproducible profiles.
6. Preserve benchmark scripts/configuration, raw measurements, environment details, summary analysis, and reviewer disposition as evidence linked to the implementation proposal. Synthetic unit-test timings are not a substitute for representative load evidence.
7. The deadline candidate may become a final default only after Haniyeh's architecture acceptance and independent security/quality review of the evidence. Until then, the numeric default remains provisional.

