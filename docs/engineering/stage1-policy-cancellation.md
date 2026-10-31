# INFINYX-ENG-001 — Stage 1 Policy Cancellation Hardening

**Status:** Documentation revision — awaiting final independent review  
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
| `AUTHORIZING` | Deny, indeterminate, invalid, stale, or required policy check fails | `FINALIZING` | Freeze Outcome Candidate `denied`; skip business execution and perform the applicable finalization/commitment checks. Never transition directly to `TERMINAL`. |
| `AUTHORIZING` | Stop request wins before authorization completes | `STOP_REQUESTED` | Pending decision cannot later reopen this attempt. |
| `AUTHORIZED` | Start accepted by lifecycle/admission gate | `RUNNING` | Admission checks in section 8 MUST pass. |
| `AUTHORIZED` | Policy invalid/revoked before admission | `FINALIZING` | Freeze Outcome Candidate `denied`; no protected operation starts; perform finalization/commitment checks before `TERMINAL`. |
| `AUTHORIZED` | Cancellation, deadline, or shutdown wins | `STOP_REQUESTED` | No execution admission. |
| `RUNNING` | Caller/shutdown cancellation wins | `STOP_REQUESTED` | Block new admissions; signal active operations and children. |
| `RUNNING` | Deadline wins | `STOP_REQUESTED` | Block new admissions; signal active operations and children. |
| `RUNNING` | Required policy revalidation denies/revokes | `STOP_REQUESTED` | Close business admission and signal active work; record pending denial classification. Once local work/children are quiescent, enter `FINALIZING` and freeze candidate `denied`. |
| `RUNNING` | All work succeeds and completion wins arbitration | `FINALIZING` | No further work; perform required bounded finalization. |
| `RUNNING` | Operational failure wins arbitration | `FINALIZING` | Stop sibling work as required; retain failure as primary result. |
| `STOP_REQUESTED` | No operation was admitted/in flight and no governed child is active, or all active work and children are confirmed quiescent | `FINALIZING` | Begin bounded finalization; signal acknowledgement alone is insufficient unless the adapter contract guarantees cessation. |
| `STOP_REQUESTED` | Stop cannot be confirmed before observation/grace bound | `UNRESOLVED` | Record unconfirmed local work; do not freeze a terminal result, claim clean cancellation, or close resources it may still use. |
| `FINALIZING` | All registered children, local operations, callbacks, and cleanup are complete or confirmed locally quiescent; all required status fields are recorded | `TERMINAL` | Perform the single Terminal Commitment using the frozen Outcome Candidate; record cleanup and external-effect status independently. |
| `FINALIZING` | Cleanup bound expires and cleanup cessation is confirmed; all other Terminal Commitment guards hold | `TERMINAL` | Commit the frozen candidate; mark cleanup timed out/failed. If cleanup may still execute, transition to `UNRESOLVED`, not `TERMINAL`. |
| `UNRESOLVED` | Later authoritative confirmation establishes quiescence | `FINALIZING` | Resume only bounded finalization/reconciliation, not business execution. |
| `UNRESOLVED` | No confirmation available | `UNRESOLVED` | Preserve unresolved status; no false terminal claim. |
| `TERMINAL` | Any late cancellation, shutdown, cleanup callback, or duplicate completion | `TERMINAL` | Reject state mutation; optionally append a safe late-event diagnostic. |

All transitions MUST be serialized by one authoritative lifecycle coordinator for the work item. Entering `FINALIZING` freezes the Outcome Candidate; entering `TERMINAL` is a separate Terminal Commitment and is allowed only when every guard in section 17.1 is satisfied. Denial before execution may move `AUTHORIZING` or `AUTHORIZED` to `FINALIZING`, never directly to `TERMINAL`. An in-flight revocation first closes admission and enters `STOP_REQUESTED`; after local quiescence it enters `FINALIZING` with candidate `denied`. A `FINALIZING` item whose cleanup or other local actor may still execute moves to `UNRESOLVED` rather than `TERMINAL`. Illegal transitions MUST be rejected and surfaced as contract violations; they MUST NOT be silently coerced into success.

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

The **linearization point** is the coordinator's atomic acceptance of an event and its corresponding state transition. In a future in-process implementation this may be a synchronous state gate or equivalent serialized mechanism; this specification does not mandate a library or introduce distributed coordination. If execution can span processes in a future architecture, that would require a separate architecture decision and is not authorized here.

Arbitration has three distinct stages; they MUST NOT be collapsed into a single “terminal transition”:

1. **Outcome Candidate Selection:** Before candidate freeze, the coordinator evaluates eligible authorization, stop, completion, and failure events under section 6.2. The winning event determines a provisional candidate; selection alone does not change the item to `TERMINAL` and MUST NOT be exposed as a final result.
2. **Candidate Freeze:** The serialized transition into `FINALIZING` freezes exactly one Outcome Candidate. This transition is the candidate-selection linearization point. Once frozen, the candidate is immutable: no later event, including denial, revocation, deadline, cancellation, completion, failure, cleanup, or shutdown, may replace or relabel it. Later events may be recorded only as bounded late-event metadata and may affect whether commitment is safe, but not which candidate was frozen. If a stop condition first wins while active work is still running, the item enters `STOP_REQUESTED`; the candidate is frozen only when it subsequently enters `FINALIZING` after the required local quiescence conditions.
3. **Terminal Commitment:** The coordinator may later transition `FINALIZING` to `TERMINAL` and publish the frozen candidate only after every guard in section 17.1 is satisfied. This is a separate, irreversible linearization point. If any guard is false or unknown—including local quiescence, registered-child cessation, callback cessation, cleanup cessation, or required status recording—commitment MUST be withheld and the item remains `FINALIZING` or becomes `UNRESOLVED` as specified by section 5.2. No event may force or bypass commitment guards.

No caller, adapter, domain module, or cleanup handler may select, freeze, rewrite, or commit an outcome outside the coordinator contract.

### 6.2 Outcome Candidate Selection and precedence rules

The following rules govern **Outcome Candidate Selection only**, while the candidate is still unfrozen. They do not authorize Terminal Commitment. The coordinator applies the rules to its serialized event sequence and freezes the selected candidate only when the lifecycle enters `FINALIZING`, in accordance with sections 5.2 and 17.1.

1. **Before admission:** Any deny, missing/indeterminate decision, invalid/stale decision, or failed required revalidation selects candidate `denied`. The item enters `FINALIZING` without business execution; it MUST NOT transition directly to `TERMINAL`.
2. **Active policy revocation:** If a required revalidation affirmatively denies/revokes while running and before candidate freeze, the coordinator blocks new admissions and selects `denied` as the primary stop classification. Already admitted operations are handled under section 8; revocation does not imply rollback. The item first enters `STOP_REQUESTED`, then enters `FINALIZING` and freezes `denied` after required local quiescence.
3. **Deadline:** If the deadline event is serialized before completion or another eligible stop event and before candidate freeze, it blocks new admissions and selects candidate `timed_out`. This candidate remains provisional until frozen; local cessation and all Terminal Commitment guards are still required before a terminal result may be published.
4. **Caller or shutdown cancellation:** If accepted before completion/failure and before candidate freeze, it blocks new admissions and selects candidate `cancelled`. This candidate remains provisional until frozen; local cessation and all Terminal Commitment guards are still required before a terminal result may be published.
5. **Completion:** Candidate `completed` may be selected only if all required work has completed and the completion event is serialized before any effective stop event and before candidate freeze.
6. **Operational failure:** Candidate `failed` may be selected if the failure event is serialized before an effective stop event and before candidate freeze. A later cancellation cannot relabel a frozen failure candidate.
7. **Simultaneous observations:** Events observed concurrently are not resolved by wall-clock guesswork. The coordinator's serialization order is authoritative and MUST be stable for that execution. Where a policy denial is already affirmatively known at an admission boundary, denial always blocks admission regardless of a concurrent caller cancellation.
8. **Same-batch tie and stop precedence:** Events in one indivisible coordinator batch with no distinct sequence use the explicit tie-break in section 17.7. A qualifying denial takes precedence as specified there; absent denial, the deadline/cancellation tie-break applies.
9. **After Candidate Freeze:** No later event may select a replacement candidate. Late denial, revocation, deadline, cancellation, completion, failure, cleanup, or shutdown events may be retained as bounded diagnostics and may prevent or delay safe commitment, but MUST NOT alter the frozen candidate.
10. **Terminal Commitment:** Candidate precedence does not satisfy commitment conditions. The frozen candidate may be published only through the separate `FINALIZING` → `TERMINAL` transition after every guard in section 17.1 and the applicable transition-matrix row in section 5.2 is satisfied. A candidate MUST NOT be exposed as a final outcome before that transition.

A stop condition accepted before candidate freeze means the attempt cannot subsequently select `completed`, even if an already-admitted non-interruptible operation later returns successfully. Its result is recorded as an external effect and reconciled as needed; the attempt retains its frozen stop candidate once it enters `FINALIZING`.

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
- [x] Independent review findings received and addressed at specification level; final independent review — pending.
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

**Document status: DOCUMENTATION REVISION — AWAITING FINAL INDEPENDENT REVIEW**  
**Implementation authorization: NOT GRANTED**


## 17. Independent review resolution — normative clarifications

This section resolves all eight findings from the independent review of
`071a1e77dd0725cd71e19721ea81c0487b1a69b6`. It is normative and controls wherever earlier wording in
sections 4–13 could be read inconsistently. It defines future contracts only;
it is not implementation evidence.

### 17.1 Outcome Candidate versus Terminal Commitment

An **Outcome Candidate** is a provisional primary classification selected by
the lifecycle coordinator when it freezes business execution and enters
`FINALIZING`. Candidate values are `completed`, `failed`, `denied`,
`cancelled`, and `timed_out`. Candidate selection is not terminal
commitment, does not make the item `TERMINAL`, and MUST NOT be exposed as a
final result.

A **Terminal Commitment** is the later, single, irreversible coordinator
transition that records the frozen candidate as the terminal outcome. It is
permitted only after: (a) business admission is closed; (b) every locally
executing operation and adapter callback has completed or confirmed local
cessation; (c) every registered child is locally quiescent; (d) cleanup has
completed or its deadline expired and cleanup cessation is confirmed; and
(e) cleanup and external-effect status are recorded separately. If cleanup
may still execute, commitment is withheld and the item remains
`UNRESOLVED`.

The candidate-selection linearization point is the serialized transition to
`FINALIZING`; the terminal-commitment linearization point is the later
transition to `TERMINAL`. They are distinct. Events before candidate freeze
participate in candidate arbitration; events after freeze cannot replace it.
If local quiescence is unconfirmed, there is no Terminal Commitment.

### 17.2 Exact START_COMMITTED contract and adapter boundary

Each operation reservation has monotonic sub-states
`RESERVED`, then either `INVALIDATED` or `START_COMMITTED`. The at-most-once
property is strictly **in-process and per live work-item/reservation identity**:
one coordinator instance may consume a reservation and invoke its adapter
entry point no more than once. It is not a durable guarantee across process
crash, restart, host failure, or loss of volatile coordinator state. It does
not guarantee that an external system applies an effect at most once.

Under one serialized, non-yielding in-process critical section (or reviewed
equivalent explicit adapter handshake), the Core Platform coordinator MUST:
1. Verify parent state is `RUNNING`, shutdown admission is open, the
   reservation is live, and Security Layer authorization affirmatively
   covers this exact action/resource/context.
2. Recheck that no stop, deadline, denial, or admission-closure event won.
3. Record `START_COMMITTED` with a unique operation ID and coordinator
   sequence.
4. Immediately invoke the adapter's synchronous `begin/start` entry point
   before releasing the critical section and before yielding or awaiting.
   The adapter MUST NOT defer the decision to initiate work until a later
   task/microtask.

That entry point MUST synchronously return one receipt:
- `NOT_STARTED`: adapter guarantees no external request/effect was initiated.
- `STARTED(handle)`: adapter accepted ownership and provides a handle for
  completion, local-cessation, and external-effect observations.
- `START_UNKNOWN`: initiation cannot be established; treat as admitted,
  prohibit retry, and mark external status unknown.

A synchronous exception means `NOT_STARTED` only if the adapter contract
guarantees it cannot throw after initiating an effect; otherwise it means
`START_UNKNOWN`. Timeout, disconnect, lost response, or cancellation is
never proof of `NOT_STARTED`. Stop serialized before step 3 invalidates
the reservation and the adapter MUST NOT be invoked. Stop after step 3
blocks later admissions and signals the admitted operation under its
adapter contract. This protocol serializes local initiation; it does not
make arbitrary remote effects atomic or provide exactly-once semantics.

**Crash/restart boundary:** the ordered record and synchronous adapter call
are serialized only while the process is alive; they are not one atomic
transaction spanning process memory and a remote system. A crash can occur
after recording `START_COMMITTED` but before the adapter call, during the
call, or after the external effect but before its receipt/result is recorded.
After restart, absent a separately approved durable recovery protocol, the
system MUST treat any such operation whose initiation/result cannot be
proven as `START_UNKNOWN` / `unknown_requires_reconciliation`, MUST NOT
replay it automatically, and MUST NOT infer `NOT_STARTED` from a missing
volatile record or missing response. If the process crashes before a
volatile `START_COMMITTED` record, that fact also cannot be used after
restart to prove that no external request escaped unless the adapter/system
provides independent authoritative evidence.

This document specifies no durable journal or cross-restart deduplication.
A future design seeking at-most-once initiation across restart would require
an approved durable operation identity and write-ahead state/recovery
protocol plus an adapter/external-system deduplication contract; even that
must state its failure assumptions and does not establish exactly-once
external effects. Recovery must reconcile by stable operation identity and
authoritative external status before any separately authorized retry. Any
retry is a new reviewed action with fresh authorization and idempotency
analysis, not a replay of the old reservation.

### 17.3 Cleanup deadline expiry and active cleanup

Cleanup has its own absolute monotonic deadline and cancellation context.
At expiry the coordinator MUST close further cleanup admission, signal every
active cleanup operation, provisionally set `cleanup_status: timed_out`,
and perform a bounded cessation observation.

If cleanup cessation is confirmed, the candidate may be committed with
cleanup status `timed_out`. If cleanup may still execute when the
observation bound expires, the work item MUST remain `UNRESOLVED`, withhold
Terminal Commitment, preserve `local_quiescence: unconfirmed`, and keep
resources it may use open. Deadline expiry is not proof of termination and
does not authorize unsafe forced closure. A separately reviewed adapter/
resource contract may define safe forced interruption/closure. Later
authoritative cessation may resume finalization, but MUST NOT restart
business work or cleanup side effects. Cleanup cannot continue without
bound.

### 17.4 Cleanup side-effect boundary and independent authorization

An accepted stop permanently closes the attempt's ordinary business
admission lane. Cleanup cannot reopen it.

**Local teardown** may release owned resources, detach listeners, and
discard local temporary state; it MUST NOT initiate a new externally
observable business mutation. Any remote call, write, notification,
compensation, deletion, transfer, or other externally observable mutation
is a **protected cleanup action**, not privileged cleanup, and is denied by
default after cancellation.

Such an action may proceed only if a reviewed cleanup plan declared its
exact action/target, purpose, bound, idempotency/recovery rule, and required
approval before execution. It MUST obtain fresh affirmative Security Layer
authorization for that cleanup action and pass a distinct cleanup admission
gate serialized against cleanup deadline, shutdown closure, and cleanup
cancellation. Authorization for the cancelled business operation is never
inherited. Human approval remains mandatory where required. Compensation
and reconciliation are separate new actions with their own identity,
authorization, approval, and audit; cleanup MUST NOT replay the original
request or silently retry an uncertain effect.

### 17.5 Atomic race: parent cancellation versus child creation

Child creation/registration is one coordinator-controlled operation. A
child MUST NOT execute domain code, acquire protected resources, or perform
side effects before registration.

The parent coordinator serializes `REGISTER_CHILD` against parent stop:
- If stop wins first, registration is rejected and no child work starts.
- If registration wins first, the child identity and ownership record are
  atomically inserted into the parent's child set before the child is
  schedulable. If parent stop wins before child start commit, child start
  is rejected and no business work executes.
- If child start commit wins first, it is a registered active child; parent
  stop propagates to it and parent quiescence waits for child local
  cessation.
- Duplicate child identity registration is rejected or idempotent, never a
  second execution.

A check-then-register sequence with an await/scheduling gap is forbidden.
Parent stop closes registration and child-start admission in the same
serialized event. No implicit orphaning, detachment, or ownership transfer
is permitted.

### 17.6 Local quiescence versus unknown external operation

Report two independent dimensions:
- `local_quiescence`: `confirmed` or `unconfirmed`, describing whether
  this process has ceased work-item code, owned children, adapter callbacks,
  and cleanup code that could issue another request.
- `external_effect_status`: `none`, `not_started`, `completed`,
  `stopped_confirmed`, or `unknown_requires_reconciliation`, describing
  the remote effect only.

A local adapter task/socket may cease while the remote system continues or
its result is unknown. In that case local quiescence can be confirmed and
Terminal Commitment may occur, with external status explicitly unknown;
this MUST NOT be described as remote termination. Conversely, a known
remote completion does not permit commitment while a local callback or
cleanup remains active. Earlier uses of `termination_status` mean local
termination only, never remote cancellation confirmation. Reconciliation
is a separate authorized action.

### 17.7 Complete precedence: denied, timed_out, cancelled

Every accepted arbitration event receives a strictly increasing
coordinator sequence; wall-clock order is diagnostic only.

1. **Pre-admission denial:** affirmative deny, missing/invalid/stale
   decision, or failed mandatory authorization check selects `denied`.
   Concurrent cancellation/deadline cannot convert unauthorized work to
   `cancelled` or `timed_out`.
2. **In-flight revocation:** affirmative policy revocation serialized while
   business work is active and before candidate freeze selects `denied`,
   closes business admission, and requests stop. It takes precedence over
   caller cancellation/deadline observed but not yet frozen.
3. **Deadline versus cancellation:** absent qualifying denial, whichever
   event is serialized first selects `timed_out` or `cancelled`.
   If both enter the same indivisible coordinator batch with no distinct
   sequence, deterministic tie-break is `timed_out` before `cancelled`.
4. **Completion/failure versus stop:** successful completion or operational
   failure freezes `completed`/`failed` only if its transition to
   `FINALIZING` is serialized before an effective stop. A later stop
   cannot rewrite it.
5. **Stop before completion/failure:** if stop is serialized first, later
   results of already-admitted work are secondary operation results, not
   replacements for the stop candidate. A qualifying policy revocation
   still follows rule 2.
6. **After candidate freeze:** no later event, including denial/deadline,
   replaces the candidate; it may be recorded as late metadata.
7. **Commitment:** delayed Terminal Commitment never reopens arbitration.

Thus denial is the fail-closed result for authorization failure known before
candidate freeze; otherwise deadline/cancellation follow coordinator
sequence and the explicit same-batch tie-break. Candidate selection and
terminal commitment remain separate.

### 17.8 Finding-to-section and verification traceability

| Independent finding | Clarified sections | Future verification scenarios |
|---|---|---|
| 1. START_COMMITTED and adapter guarantees | 8.1, 9.3, 17.2 | V-28–V-29 |
| 2. Outcome Candidate versus Terminal Commitment | 5.2, 6.1, 17.1 | V-30–V-31 |
| 3. Active cleanup after deadline | 11, 17.3 | V-32–V-33 |
| 4. Cleanup side-effect boundary | 8.2–8.3, 11, 17.4 | V-34–V-35 |
| 5. Parent cancellation versus child creation | 5.2–5.3, 9.1, 17.5 | V-36–V-37 |
| 6. Local cessation versus unknown external effect | 4, 6.3, 8.3, 17.6 | V-38–V-39 |
| 7. denied/cancelled/timed_out precedence | 4, 6.2, 17.7 | V-40–V-41 |
| 8. Acceptance matrix coverage | 13, 17.8–17.9 | V-28–V-44 |
| 9. State-matrix alignment and no direct denial-to-terminal path | 5.2, 17.1, 17.7 | V-44 |
| 10. At-most-once scope across crash/restart | 17.2 | V-42–V-43 |
| 11. START_COMMITTED crash window | 17.2 | V-42–V-43 |

### 17.9 Additional future verification scenarios

| ID | Scenario | Required assertion |
|---|---|---|
| V-28 | Stop after reservation but before START_COMMITTED | Reservation invalidated; adapter is never invoked. |
| V-29 | START_COMMITTED and adapter receipts | Synchronous handoff is enforced; receipts are classified exactly; possibly post-effect exception is unknown, never assumed not-started. |
| V-42 | Process crashes between START_COMMITTED record and adapter invocation | Restart does not infer not-started from volatile state; operation is classified unknown unless authoritative evidence proves otherwise; no automatic replay. |
| V-43 | Process crashes during/after adapter call before result recording | External status is unknown pending reconciliation by stable operation identity; no exactly-once or at-most-once-across-restart claim. |
| V-44 | Denial/revocation finalization path | Denial enters FINALIZING or STOP_REQUESTED then FINALIZING; TERMINAL is reachable only after all Terminal Commitment guards are met. |
| V-30 | Candidate frozen while cleanup is pending | Candidate remains provisional; no `TERMINAL` or final result is exposed. |
| V-31 | Late stop/denial after candidate freeze | Candidate remains immutable; late event cannot rewrite it. |
| V-32 | Cleanup deadline expires and cessation is confirmed | Cleanup admission closes; status is timed_out; frozen candidate may be committed. |
| V-33 | Cleanup deadline expires while cleanup may still execute | Item remains UNRESOLVED; no commitment; potentially used resources remain open absent reviewed safe-force-close. |
| V-34 | Cleanup attempts remote mutation after business cancellation | Default denial; no inherited business authorization or implicit bypass. |
| V-35 | Predeclared protected cleanup action has fresh authorization/approval | Only exact scoped action passes separate gate; denial/expiry blocks start; no replay. |
| V-36 | Parent stop precedes child registration | Registration rejected atomically; child code/adapter never starts. |
| V-37 | Registration wins, then parent stop races with child start | Child registered before schedulable; later start blocked or active child stopped; parent awaits local cessation. |
| V-38 | Local adapter ends but remote result is unknown | Local quiescence may be confirmed; external status remains unknown_requires_reconciliation; no remote-stop claim. |
| V-39 | Remote result known but local callback/cleanup remains active | Local quiescence unconfirmed; no Terminal Commitment. |
| V-40 | Denial/revocation races with cancellation/deadline before freeze | Qualifying denial selects denied; unauthorized work never starts. |
| V-41 | Deadline/cancellation same-batch and separate-sequence races | Same-batch tie is timed_out; otherwise first coordinator sequence wins; frozen candidate is immutable. |

## 18. Final independent review handoff

The independent review findings and subsequent clarifications have been addressed as specification text and mapped to sections and future verification scenarios. This is not a second independent
audit, runtime validation, or implementation approval. Implementation-
specific decisions in section 15 remain open and require explicit design and
review before implementation.

**Document status: DOCUMENTATION REVISION — AWAITING FINAL INDEPENDENT REVIEW**  
**Implementation authorization: NOT GRANTED**
