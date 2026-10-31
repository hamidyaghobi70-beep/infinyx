# INFINYX-ENG-001 — Stage 1 Policy Cancellation Hardening

**Status:** Documentation revision — awaiting second technical review  
**Specification maturity:** Proposed contract; not implementation evidence  
**Stage:** Stage 1 — Policy Cancellation Hardening  
**Applies to:** Core Platform lifecycle contracts and future policy-governed execution workflows  
**Repository:** `hamidyaghobi70-beep/infinyx`  
**Reviewed baseline:** `2db0777f9a9613b20169e5737b27aedc9fe78c7f`  
**Original architecture baseline:** `2aab78817b50f48a4c8125b426e3b3d5bedaba44`

## 1. Purpose and normative language

This specification defines a deterministic, fail-closed contract for stopping policy-governed work in response to authorization decisions, authorized cancellation requests, deadlines, and process shutdown. It distinguishes a request to stop from evidence that the operation has actually ceased.

The design preserves the approved modular-monolith architecture. The Core Platform owns execution lifecycle, cancellation coordination, admission gates, and terminal-state arbitration. The Security Layer owns authorization decisions and policy revalidation. Domain modules own domain work, operation-specific idempotency, and cleanup/reconciliation behavior. Modules interact through explicit contracts, not private internals.

The terms **MUST**, **MUST NOT**, **SHOULD**, and **MAY** express normative requirements. Any exception to a MUST/ MUST NOT requires an explicit, reviewed architecture/security decision; it must not be introduced implicitly by an adapter.

This document describes future contracts only. It does not assert that the repository currently has authentication, policy enforcement, durable audit storage, persistence, an Agent Runtime, or cancellation infrastructure.

## 2. Scope and non-goals

### In scope

- Work-item lifecycle and a formal transition matrix.
- Cancellation vocabulary, request acceptance, propagation, and termination confirmation.
- Policy, deadline, caller-cancellation, and shutdown arbitration.
- Race-safe admission of protected side effects.
- Child-work inheritance and bounded cleanup/reconciliation.
- Shutdown phases and resource ownership safety.
- Future observability and verification requirements.

### Out of scope

- Enabling Agent Runtime, Agent Orchestrator, Tool Gateway, Automation Engine, or any deferred capability.
- Introducing a message broker, database, distributed cancellation service, new persistence layer, or microservice.
- Defining identity-provider integration, tenant identity, authentication, or policy authoring syntax.
- Enabling external side effects, tool execution, blockchain writes, transaction signing, asset transfers, or other sensitive actions.
- Changing source code, dependencies, configuration, CI, deployment topology, or runtime behavior in this documentation stage.

## 3. Architecture and security invariants

1. **Default deny:** Missing, invalid, stale, expired, or indeterminate authorization never permits protected work.
2. **Cooperative cancellation:** A cancellation request is a request to stop, not proof of termination.
3. **Admission is fail-closed:** A protected operation may be admitted only at a defined consistency boundary where the work item is live, shutdown admission is open, and required authorization is affirmatively valid.
4. **No post-stop admission:** Once a stop request or authorization denial has won the admission-arbitration boundary, no later protected operation may be admitted.
5. **Immutable terminal outcome:** A terminal result is committed once and cannot be rewritten by late cancellation, cleanup, or shutdown events.
6. **No hidden bypass:** Child work, adapters, and domain modules may not detach from or weaken the governing cancellation and authorization context.
7. **No false success or false termination:** A stop request, grace-period expiry, or process-liveness response must not be represented as successful completion or confirmed operation termination.
8. **Explicit ownership:** Core Platform owns lifecycle mechanics; Security Layer owns policy decisions; domain modules own domain semantics and cleanup.
9. **No implicit rollback or retry:** Cancellation does not undo completed external effects. Retries require explicit idempotency design and fresh authorization.
10. **No security relaxation:** Human approval, least privilege, tenant isolation, secret redaction, and any more restrictive repository security rule remain in force.

## 4. Terminology and result model

- **Work item:** One execution attempt with a unique correlation identity, governing policy context, deadline, and lifecycle.
- **Cancellation request:** A scoped signal asking a work item to stop. Sources include an authorized caller, policy enforcement, deadline, or shutdown coordinator.
- **Stop request accepted:** The lifecycle coordinator has serialized the request against admission and completion. This does not prove that active code or an external operation has ceased.
- **Termination confirmed / quiescent:** The operation and its owned child work have ceased issuing work and the adapter/domain contract has confirmed that no governed operation remains active. This is stronger than receiving a cancellation signal.
- **Protected side effect:** Any externally observable or security-relevant mutation, including a future tool invocation, write, transfer, or other irreversible action.
- **Admission:** The atomic decision/reservation that permits one specific protected operation to begin under current lifecycle and policy conditions.
- **Reconciliation:** A separately authorized, bounded process to determine or repair the status of an external operation whose completion/cancellation is uncertain.
- **Terminal outcome:** The immutable classification of the work attempt after the outcome arbitration rule has committed it.

The minimum terminal outcomes are:

| Outcome | Meaning |
|---|---|
| `completed` | All required work completed and completion won arbitration before any effective stop condition. |
| `cancelled` | The operation became quiescent after an accepted caller or shutdown cancellation request. |
| `denied` | Policy denied admission, or a required in-flight revalidation affirmatively revoked authorization and the attempt was stopped. |
| `timed_out` | The applicable deadline elapsed and the governed operation was confirmed to have ceased. |
| `failed` | An operational failure won arbitration and was not superseded by a previously serialized policy denial or stop condition. |

A terminal outcome MUST be accompanied by separate execution/cleanup metadata where applicable. At minimum distinguish:
- `termination_status`: `confirmed` for a terminal work item; `unconfirmed` is reserved for a non-terminal `UNRESOLVED` record;
- `cleanup_status`: `not_required`, `pending`, `succeeded`, `failed`, or `timed_out`;
- `external_effect_status`: `none`, `completed`, `not_started`, or `unknown_requires_reconciliation`.

An attempt MUST NOT be marked `cancelled` or `timed_out` merely because a signal was sent or a grace period elapsed. If governed work may still be executing, its lifecycle remains stop-pending/unresolved, it has no terminal outcome, and its termination status remains unconfirmed. A terminal work item requires confirmed local quiescence; uncertainty about a remote side effect is represented separately as `external_effect_status: unknown_requires_reconciliation`. If an implementation needs to close its local request while a remote operation remains uncertain, it MUST represent that uncertainty explicitly and MUST NOT claim the remote operation stopped.

Reason codes and diagnostics MUST be bounded and non-sensitive. They MUST NOT contain credentials, tokens, policy secrets, or sensitive payloads.

## 5. Lifecycle model and formal transition matrix

### 5.1 States

The logical work-item states are:

- `CREATED`: Work identity exists; authorization has not completed.
- `AUTHORIZING`: Security Layer decision is pending.
- `AUTHORIZED`: Required authorization was affirmatively established; protected execution has not started.
- `RUNNING`: Work is admitted and may perform authorized operations.
- `STOP_REQUESTED`: A stop condition won arbitration; no new protected operation may be admitted. Active operations may still be running.
- `FINALIZING`: Work has ceased issuing new operations; bounded child joining and cleanup/reconciliation are in progress.
- `TERMINAL`: One immutable terminal outcome is committed and the governed operation is confirmed quiescent.
- `UNRESOLVED`: The local grace/observation bound expired while termination or external-effect status remains unconfirmed. This is not a successful terminal state and does not assert that work stopped.

A stop request is represented as a state transition plus source/reason metadata, not as a terminal outcome. Shutdown has a separate process-level state machine in section 10.

### 5.2 Allowed transition matrix

| Current state | Event / guard | Next state | Required behavior |
|---|---|---|---|
| `CREATED` | Begin authorization | `AUTHORIZING` | No protected work may start. |
| `CREATED` | Authorized stop request wins | `STOP_REQUESTED` | Do not start authorization-dependent work; record source. |
| `AUTHORIZING` | Affirmative policy decision and no stop/shutdown/deadline has won | `AUTHORIZED` | Record decision reference/version and validity metadata. |
| `AUTHORIZING` | Deny, indeterminate, invalid, stale, or required policy check fails | `TERMINAL` | Commit `denied`; no protected operation admitted. |
| `AUTHORIZING` | Stop request wins before authorization completes | `STOP_REQUESTED` | Pending decision cannot later reopen this attempt. |
| `AUTHORIZED` | Start accepted by lifecycle/admission gate | `RUNNING` | Admission checks in section 8 MUST pass. |
| `AUTHORIZED` | Policy invalid/revoked before admission | `TERMINAL` | Commit `denied`; no protected operation starts. |
| `AUTHORIZED` | Cancellation, deadline, or shutdown wins | `STOP_REQUESTED` | No execution admission. |
| `RUNNING` | Caller/shutdown cancellation wins | `STOP_REQUESTED` | Block new admissions; signal active operations and children. |
| `RUNNING` | Deadline wins | `STOP_REQUESTED` | Block new admissions; signal active operations and children. |
| `RUNNING` | Required policy revalidation denies/revokes | `STOP_REQUESTED` | Block new admissions; preserve denial as primary stop reason. |
| `RUNNING` | All work succeeds and completion wins arbitration | `FINALIZING` | No further work; perform required bounded finalization. |
| `RUNNING` | Operational failure wins arbitration | `FINALIZING` | Stop sibling work as required; retain failure as primary result. |
| `STOP_REQUESTED` | No operation was admitted/in flight and no governed child is active, or all active work and children are confirmed quiescent | `FINALIZING` | Begin bounded finalization; signal acknowledgement alone is insufficient unless the adapter contract guarantees cessation. |
| `STOP_REQUESTED` | Stop cannot be confirmed before observation/grace bound | `UNRESOLVED` | Record unconfirmed work; do not claim clean cancellation or close resources it may still use. |
| `FINALIZING` | Cleanup/child joining completes or its bounded policy permits final classification | `TERMINAL` | Commit exactly one outcome; record cleanup independently. |
| `FINALIZING` | Cleanup bound expires but execution is quiescent | `TERMINAL` | Commit primary outcome; mark cleanup timed out/failed. |
| `UNRESOLVED` | Later authoritative confirmation establishes quiescence | `FINALIZING` | Resume only bounded finalization/reconciliation, not business execution. |
| `UNRESOLVED` | No confirmation available | `UNRESOLVED` | Preserve unresolved status; no false terminal claim. |
| `TERMINAL` | Any late cancellation, shutdown, cleanup callback, or duplicate completion | `TERMINAL` | Reject state mutation; optionally append a safe late-event diagnostic. |

All transitions MUST be serialized by one authoritative lifecycle coordinator for the work item. The transition from `RUNNING` to `FINALIZING` on successful completion or operational failure also locks the corresponding outcome candidate at that linearization point; later stop events cannot replace that candidate. Illegal transitions MUST be rejected and surfaced as contract violations; they MUST NOT be silently coerced into success.

### 5.3 Lifecycle invariants

- `DENIED` work never enters `RUNNING`.
- `STOP_REQUESTED` and `UNRESOLVED` are non-terminal and MUST NOT be presented as confirmed termination.
- `TERMINAL` is immutable. A retry is a new work item with a new identity, authorization decision, and deadline.
- Children cannot outlive the governing parent as active governed work. A child that cannot stop keeps the parent unresolved or is represented as an explicitly owned, separately tracked operation under a reviewed contract; silent detachment is prohibited.
- Cleanup is not business execution and cannot reopen admission.
- A process may terminate before every external system confirms cessation; records must preserve that uncertainty rather than inventing confirmation.

## 6. Terminal-state arbitration and outcome precedence

### 6.1 Single serialization point

The Core Platform lifecycle coordinator is the sole owner of the work item's state and terminal arbitration. Each competing event—authorization result, admission request, cancellation request, deadline event, policy revocation, operation completion, or operational failure—MUST be submitted to this coordinator and serialized against the current state.

The **linearization point** is the coordinator's atomic acceptance of the event and state transition. In a future in-process implementation this may be a synchronous state gate or equivalent serialized mechanism; this specification does not mandate a library or introduce distributed coordination. If execution can span processes in a future architecture, that would require a separate architecture decision and is not authorized here.

Only the first eligible terminal transition committed by the coordinator wins. No caller, adapter, domain module, or cleanup handler may write terminal state directly.

### 6.2 Precedence rules

1. **Before admission:** Any deny, missing/indeterminate decision, invalid/stale decision, or failed required revalidation prevents admission and yields `denied`.
2. **Active policy revocation:** If a required revalidation affirmatively denies/revokes while running, the coordinator blocks new admissions and records `denied` as the primary stop classification. Already admitted operations are handled under section 8; revocation does not imply rollback.
3. **Deadline:** If the deadline event is serialized before completion or another stop event, it blocks new admissions and selects `timed_out`, subject to confirmed cessation before terminal commit.
4. **Caller or shutdown cancellation:** If accepted before completion/failure, it blocks new admissions and selects `cancelled`, subject to confirmed cessation before terminal commit.
5. **Completion:** `completed` wins only if all required work has completed and the completion event is committed before any effective stop event.
6. **Operational failure:** `failed` wins if the failure event is committed before an effective stop event. A later cancellation cannot relabel an already committed failure.
7. **Simultaneous observations:** Events observed concurrently are not resolved by wall-clock guesswork. The coordinator's serialization order is authoritative and MUST be stable for that execution. Where a policy denial is already affirmatively known at an admission boundary, denial always blocks admission regardless of a concurrent caller cancellation.
8. **Late events:** A stop request after terminal commit cannot rewrite the result. It may be recorded as late metadata without changing outcome, duration, or cleanup status.

A stop condition accepted before completion means the attempt cannot subsequently become `completed`, even if an already-admitted non-interruptible operation later returns successfully. Its result is recorded as an external effect and reconciled as needed; the attempt retains its selected stop classification once quiescence is confirmed.

### 6.3 Cancellation request versus termination confirmation

The API/contract MUST expose separate facts:
- request accepted/rejected and its timestamp/sequence;
- stop source and reason;
- adapter acknowledgement, if any;
- active-operation and child-work quiescence status;
- terminal outcome, only after the terminal conditions are met.

An acknowledgement that merely means “signal received” is not termination confirmation. An adapter MUST state what its acknowledgement guarantees. Unsupported cancellation MUST remain explicitly unsupported and MUST NOT be translated to `cancelled`.

## 7. Cancellation-source trust and authorization

The Security Layer owns policy decisions; the Core Platform owns the mechanics that apply them. This document does not define or assume an authentication system.

- **Trusted internal sources** are narrowly defined framework-owned events such as an elapsed deadline or process shutdown coordinator. Their provenance must be established by the owning runtime boundary, not by caller-supplied metadata.
- **Caller-originated requests** are untrusted until the future API boundary has authenticated and authorized the caller for that specific work item. A client disconnect or arbitrary HTTP cancellation header is not automatically an authorized cancellation request.
- **Policy enforcement requests** must carry a decision reference/reason from the Security Layer contract. Core Platform must not invent or weaken the policy decision.
- A cancellation request is scoped to one work-item identity and its governed descendants. It cannot cancel unrelated work or widen permissions.
- No cancellation source may grant authorization, bypass human approval, override a denial, or weaken tenant isolation.
- Source identity and reason are metadata, not proof of authority. If provenance cannot be established, the request must not gain privileged effect; protected work remains governed by existing authorization and admission checks.

## 8. Cancellation and protected side-effect admission consistency

### 8.1 The admission race

A check followed by an unrelated operation is insufficient: cancellation or policy revocation could occur between the check and the side effect. Therefore, “check immediately before the side effect” is necessary but not sufficient.

Every protected side effect MUST pass through a defined admission gate owned by the Core Platform and supplied with an affirmative authorization result from the Security Layer. The gate serializes admission against cancellation, deadline, shutdown admission closure, and terminal arbitration. It may create a bounded reservation, but reservation alone is not permission to invoke the side effect.

The operation has two distinct admission sub-states: `RESERVED` and `START_COMMITTED`. The gate MUST serialize the transition to `START_COMMITTED` against stop events. The adapter's invocation MUST be initiated as part of that same non-yielding in-process handoff (or an equivalent explicit start handshake); there must be no asynchronous gap in which a stop can win while an uncommitted reservation is later used to start work. If a stop/denial/shutdown event wins while the operation is only `RESERVED`, the reservation is invalidated and the adapter MUST NOT be invoked. Expired, abandoned, or invalidated reservations can never be reused.

The gate's start-commit decision is the ordering boundary:
- If stop/denial/shutdown closure wins before `START_COMMITTED`, admission is rejected and the side effect MUST NOT begin.
- If `START_COMMITTED` wins first, the operation is considered admitted/in flight. A later stop request prevents additional admissions and signals the admitted operation, but cannot claim that the operation never began or guarantee rollback.
- The adapter MUST report whether the operation was not started, stopped with confirmation, completed, or has unknown status.
- Each reservation and start-commit MUST be bounded and consumed/released exactly once. An expired or abandoned reservation cannot be used later to start work.

### 8.2 Authorization consistency

The Security Layer determines whether the action is authorized and whether revalidation is required. The Core Platform admission gate consumes that decision and coordinates its validity with lifecycle state; it does not reinterpret policy.

A decision must be affirmative, applicable to the specific action/resource/context, and valid at admission. Missing, stale, expired, indeterminate, or mismatched decision data fails closed. If the policy contract requires revalidation before each side effect, the gate must require a fresh affirmative decision for each such admission. A decision's validity window and revocation semantics must be explicit in the future policy contract; this document does not invent them.

If revocation is observed after an operation was admitted, no later protected operation may be admitted. The already-admitted operation follows its declared interruptibility contract and any required reconciliation.

### 8.3 External systems and uncertain effects

The Core Platform cannot atomically commit local cancellation state and an arbitrary remote side effect without a separately designed protocol. No such distributed protocol is introduced here.

- An adapter must document whether the operation is interruptible, cooperatively interruptible, non-interruptible, or status-unknown on disconnect/timeout.
- For a non-interruptible operation, the domain owner must define a bounded completion observation and reconciliation contract before the capability is enabled.
- Use operation-specific idempotency/reconciliation identifiers where the external system supports them; do not assume exactly-once execution.
- If the outcome is uncertain, record `unknown_requires_reconciliation`; do not automatically retry.
- Reconciliation is a new, explicitly authorized action with its own audit/correlation identity. It cannot silently replay the original side effect.
- Cancellation never implies compensation or rollback. Any compensation is a separate domain operation subject to policy, approval, idempotency, and its own failure handling.
- Human approval for sensitive actions remains mandatory wherever required.

## 9. Child work, deadlines, and propagation

### 9.1 Parent-child contract

Each child receives a derived context that carries the governing parent cancellation, deadline, correlation, and applicable policy constraints. A child may add a stricter local deadline or narrower scope; it MUST NOT extend the parent deadline, remove parent cancellation, weaken policy, or broaden authority.

Parent stop acceptance immediately closes child admission and propagates a stop request to every registered child. Parent termination cannot be confirmed while a governed child remains active or unresolved. A child may not silently detach, transfer ownership, or continue as background work. Any deliberate ownership transfer would require a separate explicit, reviewed contract and is not part of this stage.

### 9.2 Deadline semantics

- Deadlines are represented internally as absolute monotonic-clock deadlines, not repeated wall-clock comparisons. Wall-clock timestamps may be retained for diagnostics only.
- A child effective deadline is the earlier of its requested local deadline and its parent's effective deadline.
- A relative timeout supplied at a boundary is converted once to an absolute monotonic deadline at admission/creation; it is not restarted at each nested call.
- Clock source and behavior across process suspension/restart must be documented by the eventual runtime adapter. A monotonic deadline is process-local unless explicitly reconstructed under a reviewed contract.
- Deadline expiry is submitted to the same lifecycle coordinator as cancellation and completion.
- Cleanup has a separately bounded allowance, but cleanup allowance does not extend the business-work deadline or permit new protected business side effects.
- A retry is a new work item with a new deadline and fresh authorization. No retry inherits extra time merely because the prior attempt timed out.

### 9.3 Adapter guarantees

Every asynchronous adapter must declare one of:
- **Immediate:** it can guarantee the operation has ceased when acknowledgement returns;
- **Cooperative:** it requests stop and later provides an explicit completion/termination result;
- **Unsupported/non-interruptible:** it cannot stop the operation once admitted and must expose bounded observation/reconciliation behavior.

The contract must also specify child ownership, timeout behavior, resource release, and whether completion may race with stop acknowledgement. No adapter may overstate its guarantee.

## 10. Shutdown phases and resource safety

Shutdown is a process-level coordinator state machine. It is a cancellation source, never an authorization grant.

| Phase | Required behavior | Admission/resource rule |
|---|---|---|
| `OPEN` | Normal service lifecycle | New work/resource acquisition may be considered subject to policy. |
| `QUIESCE_ADMISSION` | Atomically close new work and protected-operation admission | No new work or protected operation may be admitted after closure wins. |
| `SIGNAL_STOP` | Request stop for all active work and propagate to children | Existing admitted operations may still be active; do not release resources they may still use. |
| `GRACEFUL_DRAIN` | Wait within a bounded, explicitly configured grace interval for cooperative stop and bounded cleanup | Track each work item as confirmed or unresolved; do not reset the deadline on repeated signals. |
| `CLASSIFY_REMAINDERS` | Mark non-terminated work as unresolved and capture safe references needed for diagnosis/reconciliation | Grace expiry is not termination confirmation. |
| `CLOSE_RESOURCES` | Close resources in declared dependency order after their owners are confirmed quiescent; handle unresolved owners according to a reviewed process-exit policy | Prevent new acquisition; do not close a resource while active work may still use it unless the resource contract explicitly defines safe forced closure. |
| `STOPPED` | Shutdown coordinator has completed its defined local teardown | Does not imply external side effects or unresolved remote work stopped. |

Additional rules:

1. The transition out of `OPEN` is one-way. Repeated shutdown signals are idempotent and cannot reopen admission or restart the grace timer.
2. Work admitted before closure remains tracked and receives the stop request. Work whose admission races with closure is ordered by the same admission gate: exactly one wins.
3. The shutdown coordinator owns the configured grace interval; this specification defines no numeric default or maximum.
4. Each resource owner declares dependencies and a safe close condition. Teardown order is deterministic and must respect those dependencies.
5. An unresolved operation must not be hidden by closing its owner resource and recording success. If process policy requires forced exit, preserve the best available unresolved status before exit; do not claim clean termination.
6. Liveness indicates only that the process can respond. It is not a readiness, dependency-health, business-work, or graceful-shutdown guarantee.
7. A future implementation must define signal handling, repeated-signal behavior, grace-period configuration authority, and forced-exit policy before release.

## 11. Cleanup, failure handling, and reconciliation

- Cleanup is bounded, best-effort, repeat-safe, and separate from business execution.
- Cleanup MUST NOT reopen protected-operation admission, extend the business deadline, or erase the primary outcome.
- Cleanup actions that themselves cause protected side effects require their own authorization and admission checks. “Cleanup” is not a policy bypass.
- Cleanup may be skipped or stopped when its own bound expires; record the reason and status.
- Preserve three independent dimensions: primary execution outcome, cleanup outcome, and external-effect/reconciliation status.
- If an unexpected exception occurs after a stop request, the coordinator retains the previously serialized primary stop classification and records the exception as a secondary diagnostic, unless the stop had not yet won arbitration.
- If an operational failure wins before any stop condition, classify `failed`; a later stop request does not rewrite it.
- Repeated cleanup invocation must be safe. Where a cleanup action cannot be made repeat-safe, its single-attempt semantics and recovery procedure must be explicit.
- No automatic retry of denied, cancelled, timed-out, or uncertain external effects. Any retry/reconciliation requires idempotency analysis and fresh authorization.

## 12. Observability and audit boundaries

When observability is implemented, structured lifecycle events should support reconstruction of ordering and outcome without sensitive payloads. The event model should include:

- Work ID, parent ID, child ID where applicable, and operation/admission ID.
- Monotonic sequence/order assigned by the lifecycle coordinator; diagnostic wall-clock timestamp separately.
- Previous state, next state, event type, and terminal outcome if committed.
- Cancellation source, bounded reason code, request-accepted/rejected status, and late-event marker.
- Policy decision reference/version and validity result where available; never policy secrets.
- Deadline classification, elapsed duration, and whether the operation was admitted.
- Adapter termination guarantee and observed termination status.
- Cleanup status and external-effect/reconciliation status.

Logs must follow the repository security baseline and Pino redaction requirements. Do not log tokens, credentials, secrets, sensitive request bodies, or unnecessary personal data. Durable audit storage, retention, access control, and tamper resistance are not assumed to exist; ordinary logs must not be represented as a durable audit system. The future design must define how event ordering is preserved if logs are asynchronous or unavailable.

## 13. Future acceptance criteria and verification matrix

All items below are future implementation acceptance criteria. They are not tests executed in this documentation-only revision.

| ID | Scenario | Required assertion |
|---|---|---|
| V-01 | Policy denied before authorization completes | Outcome is `denied`; no transition to `AUTHORIZED` or `RUNNING`; no protected admission. |
| V-02 | Missing, stale, invalid, indeterminate, or mismatched policy decision | Fail closed; no protected operation begins. |
| V-03 | Cancellation while `CREATED` or `AUTHORIZING` | Stop request is recorded; late affirmative policy result cannot reopen the attempt. |
| V-04 | Cancellation after authorization but before start | Admission is rejected; no side effect begins. |
| V-05 | Cancellation races with protected-operation admission | Coordinator ordering determines one winner; if stop wins, operation is not invoked; if admission wins, operation is tracked as in flight. |
| V-06 | Cancellation arrives after admission but before remote effect completes | No later admission; adapter reports stopped/completed/unknown honestly; no false rollback claim. |
| V-07 | Policy revocation during execution | New admissions stop; active operation follows declared adapter guarantee; terminal reason preserves denial. |
| V-08 | Parent cancellation with nested children | Stop propagates to all descendants; parent is not confirmed quiescent until all governed children are confirmed. |
| V-09 | Child attempts to outlive, detach from, or extend parent | Contract rejects detachment/extension; no untracked work remains. |
| V-10 | Repeated or competing cancellation sources | Idempotent request handling; one ordered primary stop reason and one terminal outcome. |
| V-11 | Completion races with cancellation | Linearization point yields one immutable winner; late cancellation cannot rewrite completion. |
| V-12 | Operational failure races with cancellation | Serialized event order determines primary result; secondary exception is retained safely. |
| V-13 | Deadline propagation to child | Child effective deadline never exceeds parent; timeout is not restarted by nested calls. |
| V-14 | Deadline expires during cleanup | Business deadline remains expired; cleanup is separately bounded and cannot reopen admission. |
| V-15 | Non-interruptible or status-unknown adapter | No false cancellation claim; unresolved external effect is marked for explicit reconciliation. |
| V-16 | Cleanup fails, throws, repeats, or exceeds bound | Primary outcome remains immutable; cleanup status reflects failure/timeout; repeat behavior is safe. |
| V-17 | Shutdown races with new work/admission | Admission gate orders the race; no admission after shutdown closure wins. |
| V-18 | Shutdown grace expires with active work | Work is marked unresolved/unconfirmed; no clean-stop claim; forced-exit behavior follows reviewed policy. |
| V-19 | Resource teardown while an owner is active | Resource remains available until safe close condition or explicit reviewed forced-close policy. |
| V-20 | Repeated shutdown signal | Shutdown remains idempotent; admission stays closed; grace interval is not reset. |
| V-21 | Late cancellation or callback after terminal commit | Terminal state and outcome remain unchanged; late event may be safely recorded. |
| V-22 | Cleanup itself requires a protected side effect | Cleanup passes policy/admission checks and cannot bypass human approval. |
| V-23 | Observability and event-order reconstruction | Correlation and sequence metadata reconstruct ordering without secrets or sensitive payloads. |
| V-24 | Logging/audit infrastructure absent or unavailable | No claim of durable audit; behavior remains fail-closed where policy requires evidence. |
| V-25 | Module-boundary review | Core Platform owns lifecycle mechanics; Security Layer owns decisions; domain modules own domain semantics; no private cross-module access. |
| V-26 | Scope regression | No agent/tool/automation capability, external side effect, persistence layer, broker, dependency, configuration, CI, or deployment change is introduced by this work. |
| V-27 | Human approval and tenant/security controls | Existing approval/security constraints remain mandatory and cannot be bypassed by cancellation or cleanup. |

### 13.1 Verification evidence expected before implementation acceptance

A future implementation review should include:
- A transition-table-driven unit test suite, including illegal-transition rejection.
- Deterministic concurrency tests around admission, stop, completion, failure, and terminal commit.
- Adapter contract tests proving the stated cancellation guarantee.
- Parent/child propagation and deadline-clamping tests.
- Shutdown tests covering admission closure, grace expiry, resource dependencies, and repeated signals.
- Tests for cleanup idempotency, cleanup failure, and unresolved external effects.
- Security tests for deny-by-default, policy revalidation, source provenance, tenant isolation, human approval, and secret redaction.
- Architecture review confirming no premature distributed infrastructure or deferred capability activation.

Passing these tests does not itself authorize release, deployment, or merge; repository governance and explicit approvals continue to apply.

## 14. Stage 1 deliverables and restrictions

This stage records a contract only. No runtime behavior is asserted to have changed.

- [x] Original documentation specification committed on the feature branch.
- [x] Documentation-only revision prepared for second technical review.
- [ ] Second technical review — pending.
- [ ] Implementation authorization — not granted.
- [ ] Source-code or test changes — not authorized by this revision.
- [ ] Configuration, dependency, CI, or deployment changes — not authorized.
- [ ] Merge, release, or deployment — not authorized.

The exact reviewed commit remains the immutable parent of this revision. This revision does not modify `main`, merge branches, release software, or deploy anything.

## 15. Open decisions required before implementation

The following remain explicit design decisions for a later authorized implementation proposal:

1. Concrete Core Platform interface and in-process serialization primitive for lifecycle/admission arbitration.
2. Exact policy decision schema, validity window, revalidation cadence, and revocation notification semantics owned by Security Layer.
3. Authorized caller cancellation sources and API-boundary identity/permission model.
4. Shutdown grace-period values, configuration authority, signal policy, and forced-exit behavior.
5. Adapter-by-adapter interruptibility guarantees and external-system reconciliation/compensation contracts.
6. Resource dependency graph and safe-close/forced-close policy.
7. Audit storage, retention, access control, integrity, and behavior when audit facilities are unavailable.
8. Whether any future cross-process execution is justified; no distributed coordination is assumed in this stage.

These decisions must be resolved, reviewed, and approved before implementation. This specification is not evidence that any of these systems or controls currently exist.

## 16. Related repository policy

This specification supplements, and does not override:

- `docs/architecture/overview.md`
- `docs/architecture/module-boundaries.md`
- `docs/security/security-baseline.md`
- `docs/governance/merge-authority.md`

More restrictive security controls, repository protections, and explicit approval requirements continue to apply.

---

**Document status: DOCUMENTATION REVISION — AWAITING SECOND TECHNICAL REVIEW**  
**Implementation authorization: NOT GRANTED**
