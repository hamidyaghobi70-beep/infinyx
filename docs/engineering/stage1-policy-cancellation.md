# INFINYX-ENG-001 — Stage 1 Policy Cancellation Hardening

**Status:** Documentation revision — awaiting final independent review  
**Specification maturity:** Proposed contract; not implementation evidence  
**Stage:** Stage 1 — Policy Cancellation Hardening  
**Applies to:** Core Platform lifecycle contracts and future policy-governed execution workflows  
**Repository:** `hamidyaghobi70-beep/infinyx`  
**Review target:** the exact immutable commit recorded in issue #5; the document itself does not embed a self-referential commit hash.  
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
- `cleanup_status`: `not_required`, `pending`, `succeeded`, `failed`, or `timed_out`;
- `local_quiescence`: `confirmed` or `unconfirmed`; this is the canonical local-cessation field. `termination_status` is deprecated terminology and MUST NOT be emitted as an independent or competing status. During a documented compatibility migration only, any legacy `termination_status` field MUST be a direct, lossless alias of `local_quiescence` and MUST NOT describe remote cessation.
- `external_effect_status`: `none`, `not_started`, `completed`, `failed`, `stopped_confirmed`, or `unknown_requires_reconciliation`. These are the only canonical values. `failed` means authoritative external evidence reports a terminal failure; it does not, by itself, prove that no partial external effect occurred. Any partial-effect uncertainty MUST be represented as `unknown_requires_reconciliation`. `stopped_confirmed` means authoritative evidence confirms the remote operation ceased, not merely that the local adapter stopped.

An attempt MUST NOT be marked `cancelled` or `timed_out` merely because a signal was sent or a grace period elapsed. If governed local work may still be executing, its lifecycle remains `STOP_REQUESTED` or `UNRESOLVED`, it has no terminal outcome, and `local_quiescence` remains `unconfirmed`. A terminal work item requires confirmed local quiescence, including cessation of every registered callback that can issue governed work. Uncertainty about a remote side effect is represented separately as `external_effect_status: unknown_requires_reconciliation`; that uncertainty alone does not prevent local terminal commitment once all local commitment guards are satisfied. The system MUST NOT claim that the remote operation stopped unless `stopped_confirmed` is supported by authoritative evidence.

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
- `UNRESOLVED`: The local grace/observation bound expired while local work-item, child, callback, or cleanup cessation remains unconfirmed. This is not a successful terminal state and does not assert that local work stopped. An unknown remote external-effect status alone does not make the local lifecycle `UNRESOLVED`; it is recorded independently in `external_effect_status` and may require reconciliation after local quiescence is confirmed.

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
| `STOP_REQUESTED` | The immutable per-work-item stop-observation deadline expires without authoritative local-cessation confirmation | `UNRESOLVED` | Record unconfirmed local work; do not freeze a terminal result, claim clean cancellation, or close resources it may still use. The deadline and its configuration source are governed by section 17.12. |
| `FINALIZING` | All registered children, local operations, callbacks, and cleanup are complete or confirmed locally quiescent; all required status fields are recorded | `TERMINAL` | Perform the single Terminal Commitment using the frozen Outcome Candidate; record cleanup and external-effect status independently. |
| `FINALIZING` | Cleanup bound expires; cleanup cessation is confirmed; all other Terminal Commitment guards hold | `TERMINAL` | Commit the frozen candidate; mark cleanup `timed_out` (or the independently established cleanup result). |
| `FINALIZING` | Cleanup bound expires; cleanup cessation is not confirmed or cleanup may still execute | `UNRESOLVED` | Withhold Terminal Commitment; preserve `local_quiescence: unconfirmed`; keep resources the cleanup may use open unless a reviewed resource contract explicitly permits safe forced closure. |
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

The coordinator also owns the callback registry for callbacks that can issue governed work. Callback registration, callback-start admission, and stop acceptance MUST be serialized by the same per-work-item coordinator; callback lifecycle requirements are specified in section 17.6.


The Core Platform lifecycle coordinator is the sole owner of the work item's state and terminal arbitration. Each competing event—authorization result, admission request, cancellation request, deadline event, policy revocation, operation completion, or operational failure—MUST be submitted to this coordinator and serialized against the current state.

The **linearization point** is the coordinator's atomic acceptance of an event and its corresponding state transition. In a future in-process implementation this may be a synchronous state gate or equivalent serialized mechanism; this specification does not mandate a library or introduce distributed coordination. If execution can span processes in a future architecture, that would require a separate architecture decision and is not authorized here.

Arbitration has three distinct stages; they MUST NOT be collapsed into a single “terminal transition”:

1. **Outcome Candidate Selection:** Before candidate freeze, the coordinator evaluates eligible authorization, stop, completion, and failure events under section 6.2. The winning event determines a provisional candidate; selection alone does not change the item to `TERMINAL` and MUST NOT be exposed as a final result.
2. **Candidate Freeze:** The serialized transition into `FINALIZING` freezes exactly one Outcome Candidate. This transition is the candidate-selection linearization point. Once frozen, the candidate is immutable: no later event, including denial, revocation, deadline, cancellation, completion, failure, cleanup, or shutdown, may replace or relabel it. For avoidance of doubt, candidate freeze occurs only on the serialized transition into `FINALIZING`, not when `STOP_REQUESTED` is entered; a qualifying denial/revocation serialized during `STOP_REQUESTED` and before that transition retains the fail-closed precedence in sections 6.2 and 17.9.1. Later events may be recorded only as bounded late-event metadata and may affect whether commitment is safe, but not which candidate was frozen. If a stop condition first wins while active work is still running, the item enters `STOP_REQUESTED`; the candidate is frozen only when it subsequently enters `FINALIZING` after the required local quiescence conditions.
3. **Terminal Commitment:** The coordinator may later transition `FINALIZING` to `TERMINAL` and publish the frozen candidate only after every guard in section 17.1 is satisfied. This is a separate, irreversible linearization point. If any guard is false or unknown—including local quiescence, registered-child cessation, callback cessation, cleanup cessation, or required status recording—commitment MUST be withheld and the item remains `FINALIZING` or becomes `UNRESOLVED` as specified by section 5.2. No event may force or bypass commitment guards.

No caller, adapter, domain module, or cleanup handler may select, freeze, rewrite, or commit an outcome outside the coordinator contract.

### 6.2 Outcome Candidate Selection and precedence rules

The following rules govern **Outcome Candidate Selection only**, while the candidate is still unfrozen. They do not authorize Terminal Commitment. The coordinator applies the rules to its serialized event sequence and freezes the selected candidate only when the lifecycle enters `FINALIZING`, in accordance with sections 5.2 and 17.1.

1. **Before admission:** Any deny, missing/indeterminate decision, invalid/stale decision, or failed required revalidation selects candidate `denied`. The item enters `FINALIZING` without business execution; it MUST NOT transition directly to `TERMINAL`.
2. **Policy revocation before candidate freeze:** If a required revalidation affirmatively denies/revokes after admission and before candidate freeze—including while the item is `RUNNING` or `STOP_REQUESTED`, and including when no business operation is currently active but registered callbacks or child work are still being brought to quiescence before the transition into `FINALIZING`—the coordinator blocks all new business admissions and selects `denied` as the primary classification. This is an intentional fail-closed exception to ordinary stop precedence: qualifying authorization denial/revocation may supersede a provisional stop candidate only before the transition into `FINALIZING`. Already admitted operations are handled under section 8; revocation does not imply rollback. The item enters or remains `STOP_REQUESTED` until required local cessation, then enters `FINALIZING` and freezes `denied`.
3. **Deadline:** If the deadline event is serialized before completion or another eligible stop event and before candidate freeze, it blocks new admissions and selects candidate `timed_out`. This candidate remains provisional until frozen; local cessation and all Terminal Commitment guards are still required before a terminal result may be published.
4. **Caller or shutdown cancellation:** If accepted before completion/failure and before candidate freeze, it blocks new admissions and selects candidate `cancelled`. This candidate remains provisional until frozen; local cessation and all Terminal Commitment guards are still required before a terminal result may be published.
5. **Completion:** Candidate `completed` may be selected only if all required work has completed and the completion event is serialized before any effective stop event and before candidate freeze.
6. **Operational failure:** Candidate `failed` may be selected if the failure event is serialized before an effective stop event and before candidate freeze. A later cancellation cannot relabel a frozen failure candidate.
7. **Simultaneous observations:** Events observed concurrently are not resolved by wall-clock guesswork. The coordinator's serialization order is authoritative and MUST be stable for that execution. Where a policy denial is already affirmatively known at an admission boundary, denial always blocks admission regardless of a concurrent caller cancellation.
8. **Same-batch tie and stop precedence:** Events in one indivisible coordinator batch with no distinct sequence use the explicit normalization rules in sections 17.9 and 17.9.1. A qualifying denial takes precedence as specified there; absent denial, the complete deadline/cancellation/failure/completion order applies.
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
| `CLASSIFY_REMAINDERS` | Prepare each non-terminated remainder for possible `UNRESOLVED` classification using its own lifecycle evidence and immutable observation deadline; preserve its current state while that deadline remains unexpired. Make the final `UNRESOLVED` transition only when the applicable deadline has expired and authoritative local-cessation evidence remains unavailable, as specified in section 17.12. | Process-level grace expiry alone is not termination confirmation and MUST NOT prematurely advance a work item to `UNRESOLVED` or `TERMINAL`; durable preservation before process exit is a separate requirement under section 17.12. |
| `CLOSE_RESOURCES` | Close resources in declared dependency order after their owners are confirmed quiescent; handle unresolved owners according to a reviewed process-exit policy | Prevent new acquisition; do not close a resource while active work may still use it unless the resource contract explicitly defines safe forced closure. |
| `STOPPED` | Shutdown coordinator has completed its defined local teardown | Does not imply external side effects or unresolved remote work stopped. |

Additional rules:

1. The transition out of `OPEN` is one-way. Repeated shutdown signals are idempotent and cannot reopen admission or restart the grace timer.
2. Work admitted before closure remains tracked and receives the stop request. Work whose admission races with closure is ordered by the same admission gate: exactly one wins.
3. The shutdown coordinator owns the configured grace interval; this specification defines no numeric default or maximum. This process-level grace interval is distinct from each work item's stop-observation deadline in section 17.12.
4. Each resource owner declares dependencies and a safe close condition. Teardown order is deterministic and must respect those dependencies.
5. An unresolved operation must not be hidden by closing its owner resource and recording success. If process policy requires forced exit, preserve the best available unresolved status before exit; do not claim clean termination.
6. Liveness indicates only that the process can respond. It is not a readiness, dependency-health, business-work, or graceful-shutdown guarantee.
7. A future implementation must define signal handling, repeated-signal behavior, grace-period configuration authority, and implement the forced-exit policy in section 17.12 before release.
8. `GRACEFUL_DRAIN` MAY transition to `CLASSIFY_REMAINDERS` before the configured grace deadline when every tracked work item has already reached confirmed local quiescence and all required bounded cleanup has completed or been safely ceased. The coordinator MUST NOT wait idly for the unused remainder of the grace interval. The original absolute grace deadline remains unchanged for any work still outstanding; it MUST NOT be reset or extended by early classification, repeated signals, or newly observed events. If any work remains active or unresolved, the coordinator continues the bounded drain until that original deadline, then classifies the remainder.
9. The process-level grace deadline and each work item's immutable stop-observation deadline are independent bounds. Shutdown classification MUST NOT be interpreted as proof of local cessation, MUST NOT silently shorten the per-work-item observation deadline, and MUST NOT authorize a `TERMINAL` outcome. If the process exits before an outstanding `STOP_REQUESTED` item's own deadline, its state, original immutable deadline, durable reconciliation-intent identity, and required recovery metadata MUST be preserved and made discoverable under the contract in section 17.12, except for the explicitly authorized emergency-exit exception defined there. If no approved durable sink is available or preservation cannot be verified, the process MUST enter the restricted `DEGRADED_SHUTDOWN_HOLD` policy defined in section 17.12: close all new admission, keep resources required by possibly active local work available, and do not autonomously force process exit. At the configured bounded hold deadline, escalate to the designated operator; the hold deadline MUST NOT be reset by repeated signals. A forced exit is permitted only through the existing approved, authenticated emergency-operations path with explicit acknowledgement that recovery continuity may be lost, and only when that authorization can itself be verified under an already-approved control/audit contract. If no such path is available or verifiable, the process remains in restricted hold. This policy does not authorize a new sink, control plane, or persistence mechanism.

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
- Adapter termination guarantee and canonical `local_quiescence` (`confirmed`/`unconfirmed`); any legacy `termination_status` alias must be explicitly marked deprecated and derived from that same local-only value.
- Cleanup status and external-effect/reconciliation status.
- Callback-registry counts by state (`REGISTERED`, `RUNNING`, `CANCEL_REQUESTED`, `QUIESCENT`), plus the count of work-capable callbacks still eligible to start; callback identifiers in routine logs SHOULD be bounded or pseudonymous.

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
- [x] Documentation-only revisions prepared; latest review findings addressed; final qualified independent review — pending.
- [x] Haniyeh-submitted review findings received and triaged; documentation corrections prepared; final qualified independent review — pending.
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
9. Per-work-item stop-observation and cleanup-cessation bound values, configuration authority, and adapter evidence contract.
10. Adapter/domain-owned durable reconciliation-intent sink, restart discovery contract, and bounded unresolved-record retention/capacity policy.
11. **Shutdown Preemption and Exit Policy.** The preservation/restart-discovery contract and the fail-closed no-sink/preservation-failure policy are defined in section 17.12. Under the Founder-delegated decision authority for completion of this documentation stage, Decision 11 is **RESOLVED AT THE SPECIFICATION LEVEL**: use restricted `DEGRADED_SHUTDOWN_HOLD`, bounded escalation, and verified operator-only emergency exit; there is no autonomous forced exit when recovery state cannot be preserved. This resolves the policy text only. It does not approve implementation, select numeric operational bounds, establish that an approved operator/audit path exists, or authorize new infrastructure.

These decisions must be resolved, reviewed, and approved before implementation. Decision 11 is **RESOLVED AT THE SPECIFICATION LEVEL** by the policy in section 17.12. Implementation remains blocked until the operational prerequisites are independently verified and separately approved: the bounded hold configuration and escalation owner, the existence and scope of an already-approved authenticated emergency-operations/audit path, the approved durable recovery sink for each affected capability, and the adapter-specific cessation evidence. No implementation may infer that shutdown grace expiry confirms cessation, automatically advance a work item to `UNRESOLVED` before its immutable per-work-item deadline, or autonomously exit when required state preservation is unverified. This specification is not evidence that any of these systems or controls currently exist. In addition, the stop-observation bound source/value, unresolved-record retention policy, and adapter-owned durable reconciliation-intent capability in section 17.12 must be approved before enabling any affected capability.

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
**Open design decision:** shutdown-grace/per-work-item stop-observation interaction (section 15, decision 11)


## 17. Independent review resolution — normative clarifications

This section records the seven numbered prior-specification review traceability
entries currently identified as PSR-01 through PSR-07. The available Issue #5
review record does not substantiate a separate PSR-08; accordingly, this
specification does not claim that it has resolved “all eight” historical
findings. Any additional historical finding must be produced from its source
review record and mapped explicitly before completeness can be claimed. This
section is normative and controls wherever earlier wording in sections 4–13
could be read inconsistently. It defines future contracts only; it is not
implementation evidence.

### 17.1 Outcome Candidate versus Terminal Commitment

An **Outcome Candidate** is a provisional primary classification selected by
the lifecycle coordinator when it freezes business execution and enters
`FINALIZING`. Candidate values are `completed`, `failed`, `denied`,
`cancelled`, and `timed_out`. Candidate selection is not terminal
commitment, does not make the item `TERMINAL`, and MUST NOT be exposed as a
final result.

A **Terminal Commitment** is the later, single, irreversible coordinator
transition that records the frozen candidate as the terminal outcome. It is
permitted only after: (a) business and callback-start admission are closed; (b) every locally
executing operation and every active callback capable of issuing governed
work has completed or confirmed local cessation; (c) every registered child is locally quiescent; (d) `cleanup_status` is `not_required`, or cleanup has completed, or its
deadline expired and cleanup cessation is confirmed, or cleanup terminated
with a recorded failure and its local cessation is confirmed; and (e)
cleanup and external-effect status are recorded separately. A cleanup
failure that is complete and locally quiescent MUST be recorded as
`cleanup_status: failed` and does not, by itself, prevent Terminal
Commitment or rewrite the frozen Outcome Candidate. If cleanup failed but
may still execute, or its cessation is unconfirmed, commitment is withheld
and the item transitions to `UNRESOLVED`. A cleanup exception/failed
receipt alone is not proof of cessation.

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
1. In the same serialized critical section, verify parent state is
   `RUNNING`, shutdown admission is open, the reservation is live, the
   immutable effective business deadline has not elapsed, no stop/denial/
   admission-closure event has already won, and Security Layer authorization
   affirmatively covers this exact action/resource/context.
2. Record `START_COMMITTED` with a unique operation ID and coordinator
   sequence.
3. Immediately invoke the adapter's synchronous `begin/start` entry point
   before releasing the critical section and before yielding or awaiting.
   The adapter MUST NOT defer the decision to initiate work until a later
   task/microtask.

The state, deadline, and authorization checks above are one atomic gate
against the coordinator's accepted event sequence; there is no second
check separated by a yield. This avoids implying that a non-serialized
check-then-check protocol is sufficient.

That entry point MUST synchronously return one receipt:
- `NOT_STARTED`: adapter guarantees no external request/effect was initiated.
- `STARTED(handle)`: adapter accepted ownership and provides a handle for
  completion, local-cessation, and external-effect observations.
- `START_UNKNOWN`: initiation cannot be established; treat as admitted,
  prohibit retry, and mark external status unknown.

A synchronous exception means `NOT_STARTED` only if the adapter contract
guarantees it cannot throw after initiating an effect; otherwise it means
`START_UNKNOWN`. Timeout, disconnect, lost response, or cancellation is
never proof of `NOT_STARTED`. Stop serialized before the `START_COMMITTED` record in step 2 invalidates
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

### 17.6 Callback lifecycle, registration, and cessation

The lifecycle coordinator MUST maintain an authoritative registry for every callback that can execute work on behalf of the work item, including adapter completion callbacks and domain callbacks. Each registration has a unique callback identity and an explicit state: `REGISTERED`, `RUNNING`, `CANCEL_REQUESTED`, or `QUIESCENT`.

- Registration and acceptance of a stop request are serialized by the same coordinator. If stop wins first, registration is rejected. If registration wins first, the callback is recorded before it becomes schedulable.
- Stop acceptance atomically closes registration and callback-start admission. A callback registered but not yet started MUST be suppressed/cancelled and MUST NOT begin governed work after stop acceptance.
- A callback already running when stop wins receives the governing cancellation context. The coordinator MUST track it until it reports completion or authoritative local cessation. Sending a cancellation signal or reaching a callback deadline is not cessation evidence.
- A callback MUST NOT create detached work or schedule another work-capable callback outside the same registration/admission contract. Child work must use the parent-child registration protocol in section 17.5.
- Pure control-plane cessation observers may be invoked after stop only if their contract is explicitly limited to observing/reporting cessation and they cannot issue business work, acquire protected resources, or create children. They are not counted as ordinary work-capable callbacks.
- Terminal Commitment requires no active work-capable callbacks and no pending callback capable of starting. If an active callback ignores cancellation or its cessation cannot be confirmed, local quiescence remains unconfirmed and the work item remains `UNRESOLVED`.

### 17.7 Local quiescence versus external-effect status

Report two independent dimensions:
- `local_quiescence`: `confirmed` or `unconfirmed`, describing whether
  this process has ceased work-item code, owned children, work-capable
  callbacks, and cleanup code that could issue another request.
- `external_effect_status`: one of the canonical values `none`,
  `not_started`, `completed`, `failed`, `stopped_confirmed`, or
  `unknown_requires_reconciliation`, describing the remote effect only.

The values have these meanings:
- `none`: no external effect is applicable to this operation.
- `not_started`: authoritative adapter evidence establishes that no external request/effect was initiated.
- `completed`: authoritative evidence establishes that the external operation completed.
- `failed`: authoritative external evidence establishes a terminal failure outcome. This value does not establish that no partial effect occurred; if partial-effect presence or scope remains uncertain, use `unknown_requires_reconciliation` instead.
- `stopped_confirmed`: authoritative external-system or adapter-contract evidence establishes that the remote operation ceased before completion.
- `unknown_requires_reconciliation`: available evidence cannot establish whether the external operation started, completed, or stopped.

A local adapter task/socket may cease while the remote system continues or
its result is unknown. In that case local quiescence can be confirmed and
Terminal Commitment may occur, with external status explicitly unknown;
this MUST NOT be described as remote termination. Conversely, a known
remote completion does not permit commitment while a local callback or
cleanup remains active. Any legacy `termination_status` occurrence is deprecated and means local
cessation only; it MUST NOT be interpreted as remote cancellation confirmation. Reconciliation
is a separate authorized action. `stopped_confirmed` MUST NOT be inferred
from local quiescence, socket closure, timeout, lost response, or a stop
signal alone.

### 17.8 Restart discovery and reconciliation boundary

This specification does not assume or require a database, message broker,
durable journal, or new persistence layer. It does require each future
adapter capability to declare how outstanding external operations can be
discovered after process restart and what evidence is authoritative.

The adapter/domain contract MUST classify recovery discovery as follows:

1. **Recoverable identity and authoritative query:** A stable operation
   identity can be recovered after restart, either from an already-approved
   durable source or by enumerating the external system, and the external
   system provides an authoritative status query. The operation may enter
   separately authorized reconciliation; no automatic replay is permitted.
2. **Identity recoverable, status not authoritative:** The operation can
   be identified but its external status cannot be established reliably.
   Preserve `unknown_requires_reconciliation`; do not retry. The affected
   capability remains unavailable for new sensitive work until its owner
   defines an approved resolution path.
3. **Operation identity not recoverable/discoverable:** The process cannot
   enumerate or reconstruct the outstanding operation identity after
   restart. The system MUST explicitly report that reconciliation coverage
   is unavailable; it MUST NOT claim that all outstanding effects were
   discovered or resolved. The affected capability MUST remain disabled
   until an authoritative external owner or separately approved recovery
   mechanism resolves the uncertainty.

A capability that can initiate an external effect and can end with
`unknown_requires_reconciliation` MUST reserve a durable reconciliation
intent before `START_COMMITTED`. The intent MUST contain a stable operation
identity, owning capability/adapter identity, bounded creation metadata,
and a state that is discoverable after process restart. The durable sink
MUST already be provided by an approved adapter/domain-owned system or
other separately approved mechanism; this specification does not authorize
creating a new persistence service.

Before an operation from such a capability is admitted, the coordinator
MUST verify that the adapter has reserved this durable intent and can
preserve it through that operation's uncertain-outcome path. If no such durable sink/reservation is
available, or the reservation cannot be confirmed, the admission MUST fail
closed and the affected sensitive capability MUST remain disabled. On an
uncertain outcome, the adapter MUST mark the reserved intent as pending
reconciliation. The pre-existing durable intent itself MUST remain
sufficient for restart discovery if the post-effect status update is lost;
a missing final update is interpreted as unresolved, never as not-started.

If the authoritative external query is temporarily unavailable after
restart, the pending intent MUST remain discoverable and unresolved; the
capability MUST remain disabled for new sensitive work until an
authoritative owner resolves the record or a separately approved recovery
mechanism does so. Temporary query unavailability MUST NOT cause the intent
to be deleted, treated as resolved, or silently skipped.

A volatile in-memory coordinator record is not restart-discoverable evidence.
A missing record after restart does not prove that no external request was
sent. If an adapter cannot meet a declared discovery/reconciliation
requirement, that limitation must be explicit in its capability contract
and the capability must not be enabled for sensitive external effects.
These requirements specify a contract and do not authorize adding storage,
a journal, a broker, or any other infrastructure in this documentation
stage. A capability without an approved adapter/domain-owned durable intent
sink is not eligible for sensitive external-effect admission under this
contract.

### 17.9 Coordinator event sequence and same-batch ordering

Every accepted arbitration event MUST receive a unique, strictly
increasing coordinator sequence. Two accepted events MUST NOT share a
sequence, including events first observed in the same indivisible batch.
The sequence is assigned at coordinator ingestion; wall-clock order is
diagnostic only.

If multiple observations arrive in one indivisible batch without a
pre-existing order, the coordinator MUST normalize them using this complete
deterministic event-class precedence before assigning individual sequence
numbers:

1. Qualifying authorization denial/revocation;
2. Deadline expiry;
3. Authorized caller or shutdown cancellation;
4. Operational failure;
5. Successful completion.

Within one event class, a stable secondary key SHOULD be used for
repeatable diagnostic ordering when one exists. If no stable key exists,
the coordinator MAY use its batch-ingestion ordinal for assigning unique
sequence numbers; this within-class order is diagnostic only and MUST NOT
change the selected outcome class. Events within the same class have the
same precedence, so implementations MUST NOT derive different primary
outcomes from their internal ordering of same-class events. The coordinator then assigns each accepted event its own
increasing sequence in that normalized order. This same-batch precedence is
an explicit contract, not a deployment-specific implementation choice.
A qualifying denial/revocation is considered only while the candidate is
unfrozen; no event can rewrite a frozen candidate.

For same-batch events, the complete order above applies, including
`timed_out` before `cancelled`, either stop class before operational
failure, and operational failure before completion. For separately accepted
events, the first coordinator sequence wins, subject to the qualifying
pre-freeze denial/revocation rule in section 17.9.1. Candidate freeze
remains immutable and Terminal Commitment remains a separate later
transition.

### 17.9.1 Outcome precedence: denied, timed_out, cancelled

Every accepted arbitration event receives a strictly increasing
coordinator sequence; wall-clock order is diagnostic only.

1. **Pre-admission denial:** affirmative deny, missing/invalid/stale
   decision, or failed mandatory authorization check selects `denied`.
   Concurrent cancellation/deadline cannot convert unauthorized work to
   `cancelled` or `timed_out`.
2. **Post-admission revocation before freeze:** affirmative policy
   revocation serialized after admission and before candidate freeze
   selects `denied`, closes business admission, and requests/continues stop.
   This applies while `RUNNING` and while `STOP_REQUESTED`, including when
   no business operation is currently active but callbacks or child work are
   still being brought to quiescence before the transition into `FINALIZING`.
   Cleanup occurs only during `FINALIZING`; it is not part of the pre-`FINALIZING`
   revocation window and cannot reopen candidate selection. It takes precedence over
   a provisional caller-cancellation/deadline/failure/completion candidate
   only before the transition into `FINALIZING`.
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
   replacements for the provisional stop candidate. A qualifying policy
   revocation still follows rule 2 until candidate freeze. This asymmetry is
   intentional: denial is the fail-closed authorization result and may
   supersede a provisional stop classification before freeze; completion
   and operational failure are ordinary post-admission outcomes and do not
   have that privilege.
6. **After candidate freeze:** no later event, including denial/deadline,
   replaces the candidate; it may be recorded as late metadata. Freeze
   occurs only on entry to `FINALIZING`, never merely on entry to
   `STOP_REQUESTED`.
7. **Commitment:** delayed Terminal Commitment never reopens arbitration.

Thus denial is the fail-closed result for authorization failure known before
candidate freeze; otherwise deadline/cancellation follow coordinator
sequence and the explicit same-batch tie-break. Candidate selection and
terminal commitment remain separate.

### 17.10 Finding-to-section and verification traceability

Finding identifiers are source-scoped, not one global sequence. The submitted
Haniyeh report recorded in Issue #5 contains F-01 through F-05; it explicitly
contains no F-06. The DeepSeek review record in Issue #5 uses F-10 through
F-14 and NEW-01 through NEW-14. No DeepSeek F-01 through F-09 source findings
are present in the recorded review material; those identifiers are therefore
not inferred, renumbered, or represented as omitted findings here. The PSR
series below is a separate seven-entry traceability set; its completeness is
limited to the source material actually identified above.

| Review finding | Clarified sections | Future verification scenarios |
|---|---|---|
| PSR-01 — Prior specification review: START_COMMITTED and adapter guarantees | 8.1, 9.3, 17.2 | V-28–V-29 |
| PSR-02 — Prior specification review: Outcome Candidate versus Terminal Commitment | 5.2, 6.1, 17.1 | V-30–V-31 |
| PSR-03 — Prior specification review: Active cleanup after deadline | 11, 17.3 | V-32–V-33 |
| PSR-04 — Prior specification review: Cleanup side-effect boundary | 8.2–8.3, 11, 17.4 | V-34–V-35 |
| PSR-05 — Prior specification review: Parent cancellation versus child creation | 5.2–5.3, 9.1, 17.5 | V-36–V-37 |
| PSR-06 — Prior specification review: Local cessation versus unknown external effect | 4, 6.3, 8.3, 17.7 | V-38–V-39 |
| PSR-07 — Prior specification review: denied/cancelled/timed_out precedence | 4, 6.2, 17.9.1 | V-40–V-41 |
| Haniyeh review F-01: callback registration/start/cessation | 5.2, 6.1, 17.6 | V-45–V-46 |
| Haniyeh review F-02: restart discovery and no unintended retry | 8.3, 15, 17.8 | V-42–V-43, V-47 |
| Haniyeh review F-03: local UNRESOLVED versus external uncertainty | 4, 5.1, 17.7–17.8 | V-48 |
| Haniyeh review F-04: canonical external-effect enum | 4, 17.7 | V-49 |
| Haniyeh review F-05: unique event sequence and batch normalization | 6.2, 17.9 | V-50 |
| Haniyeh review F-06: no F-06 finding was present in the submitted Haniyeh report; explicitly recorded as not issued, not silently omitted | Review record / this traceability table | N/A — no finding was issued |
| Unattributed historical reference F-07: provenance not established; not attributed to the submitted Haniyeh report or counted as an issued Haniyeh finding | 5.2, 17.1 | V-44 (contract scenario only; not evidence of an issued finding) |
| DeepSeek review F-10: FINALIZING cleanup cessation transition | 5.2, 17.1, 17.3 | V-33, V-52 |
| DeepSeek review F-11: distinguish definitive external failure from uncertainty | 4, 17.7 | V-53 |
| DeepSeek review F-12: canonical local quiescence terminology | 4, 12, 17.7 | V-48, V-54 |
| DeepSeek review F-13: ordered verification scenarios and complete finding traceability | 17.10–17.11 | V-42–V-44, V-47, V-52–V-55 |
| DeepSeek review F-14: early graceful-drain completion | 10 | V-51 |
| DeepSeek NEW-01: per-work-item stop-observation bound | 5.2, 9.2, 15, 17.12 | V-58 |
| DeepSeek NEW-02: complete same-batch event-class precedence | 6.2, 17.9, 17.9.1 | V-56–V-57 |
| DeepSeek NEW-03: restart-durable reconciliation intent | 8.1, 8.3, 17.2, 17.8, 17.12 | V-60 |
| DeepSeek NEW-04: `cleanup_status: not_required` terminal guard | 4, 17.1 | V-59 |
| DeepSeek NEW-05: complete review-finding traceability; F-06 explicitly not issued | 17.10 | V-55 |
| DeepSeek NEW-06: bounded unresolved-record retention and admission backpressure | 5.2, 10, 12, 17.12 | V-62 |
| DeepSeek NEW-07: candidate-freeze/revocation asymmetry | 6.1, 6.2, 17.9.1 | V-61 |
| DeepSeek NEW-08: revocation during STOP_REQUESTED without active business work | 6.2, 17.9.1 | V-61 |
| DeepSeek NEW-09: callback-state observability | 12, 17.6 | V-63 |
| DeepSeek NEW-10: use canonical STOP_REQUESTED terminology | 4, 5.2 | V-64 |
| DeepSeek NEW-11: define affected capability scope | 17.8 | V-65 |
| DeepSeek NEW-12: adapter-declared cleanup cessation observation bound | 9.3, 17.3, 17.12 | V-66 |
| DeepSeek NEW-13: cross-reference outcome normalization rules | 6.2 | V-56–V-57 |
| DeepSeek NEW-14: remove redundant coordinator recheck step | 17.2 | V-29 |
| Haniyeh C-01: completed cleanup failure and Terminal Commitment | 4, 11, 17.1 | V-67 |
| Haniyeh C-02: UNRESOLVED retention expiry, archive integrity, and resolution authority | 12, 17.8, 17.12 | V-68

### 17.11 Additional future verification scenarios

| ID | Scenario | Required assertion |
|---|---|---|
| V-28 | Stop after reservation but before START_COMMITTED | Reservation invalidated; adapter is never invoked. |
| V-29 | START_COMMITTED and adapter receipts | Synchronous handoff is enforced; receipts are classified exactly; possibly post-effect exception is unknown, never assumed not-started. |
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
| V-42 | Process crashes between START_COMMITTED record and adapter invocation | Restart does not infer not-started from volatile state; operation is classified unknown unless authoritative evidence proves otherwise; no automatic replay. |
| V-43 | Process crashes during/after adapter call before result recording | External status is unknown pending reconciliation by stable operation identity; no exactly-once or at-most-once-across-restart claim. |
| V-44 | Denial/revocation finalization path | Denial enters FINALIZING or STOP_REQUESTED then FINALIZING; TERMINAL is reachable only after all Terminal Commitment guards are met. |
| V-45 | Callback registration races with stop acceptance | Coordinator serialization yields one winner; if stop wins registration is rejected; if registration wins the callback is registered but cannot start after stop closure unless already running and tracked. |
| V-46 | Stop accepted while callbacks are pending or running | Pending work-capable callbacks are suppressed; active callbacks receive cancellation; no Terminal Commitment until all active callbacks cease. |
| V-47 | Restart with no durable journal and no external enumeration | System reports discovery coverage unavailable; does not infer not-started, claim complete reconciliation, or automatically retry; affected sensitive capability remains disabled. |
| V-48 | Local quiescence confirmed while external effect remains unknown | Local lifecycle may commit terminal with `unknown_requires_reconciliation`; it is not labeled `UNRESOLVED` solely due to remote uncertainty and makes no remote-stop claim. |
| V-49 | External-effect status value validation | Only `none`, `not_started`, `completed`, `failed`, `stopped_confirmed`, and `unknown_requires_reconciliation` are accepted; `failed` requires authoritative terminal-failure evidence and does not imply absence of partial effects; `stopped_confirmed` requires authoritative cessation evidence. |
| V-50 | Deadline and cancellation observed in one indivisible batch | Coordinator normalizes deadline before cancellation, then assigns unique increasing sequences; no two accepted events share a sequence. |
| V-51 | All work reaches confirmed local quiescence before the GRACEFUL_DRAIN deadline | Shutdown MAY classify early; the original deadline is not reset or extended, and no unresolved/active work is omitted. |
| V-52 | FINALIZING cleanup bound expires with cessation unconfirmed | Transition to UNRESOLVED; withhold Terminal Commitment; retain resources absent reviewed safe forced closure. |
| V-53 | External system authoritatively reports terminal failure | `external_effect_status: failed` is distinct from unknown; partial-effect uncertainty remains unknown and is not silently treated as no effect. |
| V-54 | Local quiescence metadata is emitted | `local_quiescence` is canonical; deprecated `termination_status`, if temporarily emitted, is a lossless local-only alias and never remote status. |
| V-55 | Traceability and verification inventory are reviewed | Every issued review finding maps to clarifying sections and future scenarios; F-06 is explicitly marked not issued in the source report; scenario identifiers are strictly ascending and unique. |
| V-56 | Completion and deadline arrive in one indivisible coordinator batch | The documented same-batch order selects `timed_out` before `completed`; the result is stable and repeatable. |
| V-57 | Failure and cancellation arrive in one indivisible coordinator batch | The documented same-batch order selects `cancelled` before `failed`; the result is stable and repeatable. |
| V-58 | Stop is acknowledged but local cessation is never confirmed | The item remains `STOP_REQUESTED` until its immutable configured observation deadline. If cessation remains unconfirmed at that deadline, it transitions to `UNRESOLVED` at that deadline. An earlier transition to `UNRESOLVED` is permitted only when authoritative evidence establishes that the adapter cannot provide its declared cessation guarantee; delay or absence of acknowledgement alone is insufficient. |
| V-59 | Work item reaches `FINALIZING` with `cleanup_status: not_required` | Terminal Commitment does not wait for a nonexistent cleanup deadline; all other guards still apply. |
| V-60 | External operation becomes uncertain and process restarts | A pre-reserved durable intent remains discoverable; if status query is unavailable, it remains pending and the affected capability stays disabled; without a durable sink, admission was rejected before start. |
| V-61 | Qualifying revocation arrives during `STOP_REQUESTED` before candidate freeze, with no active business operation | Revocation selects `denied`; after entry to `FINALIZING`, the candidate is frozen and later revocation cannot rewrite it. |
| V-62 | Unresolved work items accumulate or reach configured retention capacity | Records are not silently evicted; bounded retention/backpressure is applied, new affected admissions fail closed, and resources are not released while local actors may still use them. |
| V-63 | Callback registry is observed during and after stop | Structured observability reports bounded counts for each callback state and active work-capable callbacks; no sensitive callback payload is logged. |
| V-64 | Legacy prose uses stop-pending terminology | The normative lifecycle vocabulary consistently uses `STOP_REQUESTED`; no undocumented state is introduced. |
| V-65 | Adapter cannot enumerate outstanding operations after restart | The exact adapter/capability scope is identified; all operations routed through that adapter are disabled where discovery guarantees are insufficient, unless a narrower independently enforced scope is proven. |
| V-66 | Cleanup cessation observation bound is exercised | The bound is declared by the resource/adapter contract, frozen when cleanup starts, uses a monotonic clock, and expiry without cessation confirmation leads to `UNRESOLVED`. |
| V-67 | Cleanup terminates with a recorded failure and cessation is confirmed | Preserve `cleanup_status: failed`; permit Terminal Commitment only after all other guards hold; retain the frozen primary candidate; an exception without cessation evidence remains `UNRESOLVED`. |
| V-68 | UNRESOLVED retention threshold is reached | Do not resolve or delete on expiry; verify durable archive acceptance, integrity, identity/reconciliation linkage, accountable resolution authority, and fail-closed backpressure if transfer is unavailable. |
| V-69 | Process shuts down while a work item with a durable reconciliation intent is in `STOP_REQUESTED` | The work item's state and original immutable stop-observation deadline are successfully persisted to the approved durable sink, and durable acceptance is verified. No false terminal claim is made. On restart, the record is discoverable through section 17.8 without automatic retry or cancellation. |
| V-70A | **Hold control:** Shutdown preservation fails because no approved sink is available or durable acceptance cannot be verified | Enter restricted `DEGRADED_SHUTDOWN_HOLD`; close new admissions; preserve required resources; capture and enforce the strictly bounded, immutable hold deadline; escalate to the accountable operator at expiry; do not autonomously force exit or treat process-grace expiry as local cessation. This scenario verifies hold, deadline, resource, and escalation behavior only; it does not authorize or assess emergency exit. |
| V-70B | **Emergency-exit authorization:** An emergency exit is requested while shutdown preservation is unavailable or unverified | Verify that exit is prohibited unless an already-approved operator-control path provides authenticated operator identity, explicit attributable authorization for the affected scope, acknowledgement of possible recovery-continuity loss, and independently verifiable audit evidence. If authentication, authorization, the independent audit channel, or its evidence is absent, unavailable, or uncertain, deny exit and remain in restricted hold. After any separately authorized exit, keep affected capabilities disabled until separately authorized reconciliation. |

### 17.12 Immutable observation bounds, unresolved retention, and recovery capacity

**Shutdown preemption and restart discovery.** When the process-level shutdown grace deadline occurs while a work item with a durable reconciliation intent remains in `STOP_REQUESTED` and its immutable per-work-item stop-observation deadline has not expired, the Coordinator MUST preserve the work item's current lifecycle state, original immutable stop-observation deadline, durable reconciliation-intent identity/locator, adapter/capability identity, and required recovery metadata in the already-approved durable sink associated with that intent or another already-approved durable recovery sink. The Coordinator MUST verify the destination's durable acceptance and required identity/integrity fields before treating preservation as successful. A preservation attempt, ordinary log entry, volatile in-memory state, or unacknowledged write is not durable acceptance. The process MUST NOT represent shutdown-grace expiry as local cessation, transition the item to `UNRESOLVED` before its own deadline solely because the process is shutting down, or commit `TERMINAL`. If preservation succeeds, restart discovery MUST recover the record through the contract in section 17.8, retain the original deadline, and continue observation/reconciliation under the applicable adapter contract; no automatic business retry or cancellation is permitted. If no approved durable sink is available or preservation cannot be verified, the Coordinator MUST NOT claim that the outstanding state was safely preserved. The process MUST follow the fail-closed shutdown policy defined immediately below. This specification does not authorize a new persistence mechanism. A process exit is permitted only under the verified emergency-exit exception defined below.

**Fail-closed exit policy when preservation is unavailable — `DEGRADED_SHUTDOWN_HOLD`.** If the Coordinator cannot verify durable preservation of any outstanding `STOP_REQUESTED` work item because no approved durable sink is available, the write fails, or destination acceptance/integrity cannot be verified, it MUST enter `DEGRADED_SHUTDOWN_HOLD`. This is a process-level restricted state, not a work-item lifecycle state and not a terminal outcome. The Coordinator MUST close new work admission and all new protected-operation admission, keep the affected capability disabled, preserve in-memory evidence without representing it as durable, and keep resources open where possibly active local work may still depend on them. It MUST NOT reset the process shutdown grace deadline or the separately captured hold deadline in response to repeated signals.

The hold duration MUST be a strictly positive, bounded operational value configured through an already-approved configuration/ownership process; this specification intentionally assigns no numeric value. Before the hold deadline, the process MAY continue only the observation and safe cessation work already authorized for the outstanding items. It MUST NOT start business work, retry an external business operation, or create a substitute persistence mechanism. A critical escalation MUST be raised through an already-approved operational channel when available; alert delivery is not evidence of durable state preservation.

At the hold deadline, the Coordinator MUST escalate to the designated accountable operator and remain in restricted hold. It MUST NOT autonomously force process exit. A forced exit is an emergency exception and is permitted only when an existing approved authenticated operator-control path supplies an explicit, attributable authorization that acknowledges possible loss of recovery continuity, and the authorization is verifiable under an already-approved control/audit contract. No new control plane or audit sink is authorized by this specification. If the operator path or its authorization evidence is unavailable or unverifiable, the process MUST remain in restricted hold rather than silently treating the risk as accepted.

**Emergency-exit authentication and audit prerequisites.** The operator-control path MUST use an authentication and authorization mechanism that has been separately specified, implemented, independently reviewed, and approved for this high-impact action. The repository's current `docs/security/security-baseline.md` explicitly lists authentication/authorization and durable audit storage as not yet implemented; that document is a status reference, not evidence that these controls exist or a complete authentication standard. Accordingly, the emergency-exit exception MUST be treated as unavailable unless the required controls are subsequently established and verified. Before exit, the explicit authorization and its attribution MUST be verifiably recorded through an already-approved audit channel that is independent of the failing preservation sink and whose availability/integrity can be established at decision time. The record MUST identify, at minimum, the authorizing operator, the authorized emergency-exit action and affected scope, the authorization time, and the acknowledgement that recovery continuity may be lost. This requirement does not authorize creation of a new audit channel or imply that an independent channel currently exists. If the authentication controls, independent audit channel, or verifiable record are absent, unavailable, or uncertain, emergency exit MUST NOT occur and the process MUST remain in restricted hold.

Following an authorized emergency exit, any affected capability MUST remain disabled on restart until the outstanding operation's status is authoritatively reconciled or an accountable operator records an explicit, separately authorized recovery disposition through an already-approved control/audit process. Missing recovery records MUST NOT be interpreted as evidence that the operation ceased or that re-enablement is safe. This emergency path accepts a documented availability cost to preserve fail-closed behavior; it does not guarantee recoverability when the approved sink is unavailable.

**Per-work-item stop observation.** Each adapter capability MUST declare a
strictly positive maximum local-stop observation duration and the evidence
that constitutes authoritative local cessation. A separately reviewed
platform configuration selects the effective duration; this specification
does not invent a universal numeric value. The effective duration MUST be
strictly positive and MUST NOT exceed the adapter-declared maximum. If the
selected platform configuration exceeds that maximum, the configuration is
a contract violation and work-item creation/admission MUST fail closed before
protected work can begin. The effective duration and its
configuration/version reference MUST be captured immutably when the work
item is created. The absolute stop-observation deadline is calculated once
from the monotonic time at which `STOP_REQUESTED` is accepted. Repeated
signals, duplicate events, child activity, or scheduling delays MUST NOT
reset or extend it. The coordinator MUST NOT transition to `UNRESOLVED`
before this deadline solely because confirmation has not yet arrived; if
cessation remains unconfirmed, it MUST transition to `UNRESOLVED` at the
deadline, subject only to an earlier authoritative determination that the
adapter cannot provide the declared guarantee. A child stop-observation deadline is the earlier of the parent's absolute
deadline and the monotonic timestamp at child stop acceptance plus the
effective duration selected for the child capability. The child's effective
duration MUST be strictly positive and MUST NOT exceed that child capability's
declared maximum; the child cannot extend the parent's absolute deadline. If a capability
cannot declare and satisfy this contract, it MUST NOT be enabled for
governed asynchronous work.

**Cleanup cessation observation.** The resource/adapter contract MUST
declare a strictly positive cleanup-cessation observation duration and
authoritative cessation evidence. The effective value is captured when
cleanup begins and converted once to an absolute monotonic deadline. It
cannot be reset by repeated cleanup signals. At expiry, the rules in
section 17.3 apply. The process-level shutdown grace interval in section
10 is independent and does not replace either per-work-item bound.

**Unresolved retention, archival disposition, and bounded capacity.** A
capability MUST declare a bounded retention policy for `UNRESOLVED`
work-item records, including maximum record size, maximum retained
count/bytes, retention duration, accountable owner, escalation destination,
and the approved disposition after the retention threshold. Expiry of the
retention duration MUST NOT itself resolve the operation, authorize record
deletion, or constitute evidence of local or remote cessation.

Before the active retention threshold is reached, the accountable owner
MUST ensure that the record is either retained in its approved durable
recovery sink or transferred to an already-approved durable archive/evidence
store. This specification does not authorize a new database, journal,
broker, archive service, or other infrastructure. The transfer MUST be
verifiable and preserve, at minimum, the immutable work-item and operation
identities, adapter/capability identity, original creation and event
metadata, unresolved reason, `local_quiescence`, `external_effect_status`,
the durable reconciliation-intent identity and locator, the evidence/
provenance references, and the responsible owner. The transfer MUST preserve
integrity and access controls and provide a durable reference from the
active recovery record to the archived evidence, and vice versa where the
archive supports backlinks. A transfer is not complete until the destination
acknowledges durable acceptance and the required fields/integrity checks
succeed.

Only the designated accountable domain/adapter owner, acting under the
repository's applicable approval and audit controls and supported by
authoritative cessation/status evidence or a separately approved recovery
decision, may record a resolution disposition. Retention expiry, archive
transfer, capacity pressure, process shutdown, or an operator's inability
to query the external system MUST NOT be treated as resolution. The record
MUST retain its unresolved history and reconciliation linkage after a
resolution disposition; archival is not deletion and does not erase audit
evidence. Any later deletion, if legally and operationally permitted, must
follow a separately approved retention/destruction policy and MUST NOT
destroy evidence still subject to reconciliation, audit, legal hold, or
security investigation.

If local actors may still execute, resources they may use remain open unless
a reviewed resource contract explicitly permits safe forced closure;
reaching a retention threshold is not cessation evidence. When the configured
capacity is reached, the coordinator MUST apply admission backpressure and
reject new affected work fail-closed until capacity is safely recovered. It
MUST NOT evict unresolved records to make room. If a durable retention/
recovery sink or approved archive destination is required but unavailable,
or transfer cannot be verified, affected new admissions remain disabled
and the source record MUST be retained. Any compaction or transfer must
preserve the work identity, unresolved reason, local quiescence status,
external-effect uncertainty, and reconciliation link.

**Affected capability scope.** In section 17.8, “affected capability” means
the narrowest capability boundary that is independently enforced and can
be disabled without leaving an alternate route to the same sensitive
operation. By default this is the adapter capability and all operations
routed through that adapter. A narrower operation-type scope is permitted
only when routing, authorization, and admission controls can prove that
the unaffected operations cannot invoke or bypass the unresolved path.
The owner MUST identify the scope in the adapter contract; ambiguous scope
defaults to disabling all sensitive operations routed through that adapter.

**Reconciliation intent reservation.** For every external-effect capability
covered by section 17.8, the adapter/domain owner MUST reserve the
restart-discoverable intent before `START_COMMITTED`. The intent sink must
be an already-approved durable owner system; a volatile coordinator map,
ordinary log, or best-effort telemetry stream is not sufficient. If no such
sink exists, or its reservation cannot be acknowledged before admission,
the protected operation MUST NOT start. The durable intent is the recovery
anchor if the post-effect status update is lost. Temporary unavailability
of external enumeration/query after restart leaves the record pending and
the affected capability disabled; it does not erase the obligation.

**Coordinator same-batch event order.** The normative order is the complete
five-class precedence in section 17.9: denial/revocation, deadline,
caller/shutdown cancellation, operational failure, then completion.
Implementations may use different internal scheduling primitives, but
they MUST produce this same outcome for an equivalent indivisible event
batch. This contract applies to in-process implementations; a future
multi-process coordinator remains out of scope and requires a separate
architecture decision.

### 17.13 Invariant-to-contract traceability

| Invariant | Normative sections | Future scenarios |
|---|---|---|
| Default deny / no protected work without affirmative authorization | 3, 6.2, 8.1–8.2 | V-01–V-05, V-22, V-27 |
| Stop request is not termination evidence | 3, 4, 5.1–5.3, 6.3, 17.3, 17.7, 17.12 | V-06, V-15, V-18, V-33, V-38, V-52, V-58, V-66 |
| Admission and stop are coordinator-serialized | 3, 6.1–6.2, 8.1, 17.2, 17.5–17.6 | V-05, V-28–V-29, V-36–V-37, V-45 |
| Candidate freeze and terminal commitment are distinct | 5.2, 6.1–6.2, 17.1, 17.9.1 | V-30–V-31, V-40–V-41, V-44, V-61 |
| No child/callback detachment or post-stop start | 3, 5.3, 9.1, 17.5–17.6 | V-08–V-09, V-36–V-37, V-45–V-46 |
| Local quiescence is distinct from remote effect status | 4, 5.1, 17.7–17.8 | V-15, V-38–V-39, V-47–V-49, V-60 |
| Cleanup is bounded and cannot bypass authorization | 8.3, 9.2–9.3, 11, 17.1, 17.3–17.4, 17.12 | V-14, V-16, V-22, V-32–V-35, V-66–V-67 |
| Shutdown/resource safety and bounded retention | 10, 12, 17.8, 17.12 | V-17–V-20, V-47, V-62, V-68, V-70A |
| Shutdown preemption preserves outstanding lifecycle state without treating grace expiry as cessation | 3, 5.1–5.3, 10 (rule 9), 15 (Decision 11), 17.8, 17.12 | V-69, V-70A |
| Failed shutdown preservation defaults to restricted hold | 3, 10 (rule 9), 15 (Decision 11), 17.12 | V-70A |
| Bounded degraded-shutdown hold, immutable deadline, and escalation | 10 (rules 7 and 9), 15 (Decision 11), 17.12 | V-70A |
| Emergency exit requires approved operator authentication, attributable authorization, and independently verifiable audit evidence; unavailable controls prohibit exit | 3, 10 (rule 9), 15 (Decision 11), 17.12, `docs/security/security-baseline.md` | V-70B |
| Explicit ownership of lifecycle, policy, domain work, and cleanup | 3, 7, 16 | V-25, V-27 |
| No implicit rollback or retry; retries require explicit idempotency and fresh authorization | 8.3, 11, 17.4 | V-16, V-22, V-35 |
| No relaxation of human approval, least privilege, tenant isolation, or secret controls | 3, 7, 16 | V-27 |
| Terminal state is immutable and auditable | 3, 5.2–5.3, 6.1–6.2, 12, 17.1, 17.9 | V-10–V-12, V-21, V-23, V-30–V-31, V-55–V-57 |
| No unapproved infrastructure or deferred capability activation | 2, 14–16, 17.8, 17.12 | V-26, V-47, V-60, V-65 |

## 18. Final independent review handoff

The earlier specification-review clarifications represented by PSR-01 through PSR-07 and the five findings actually issued in the Haniyeh-submitted report (F-01 through F-05) have been incorporated as proposed contract text and mapped to future verification scenarios. The submitted Haniyeh report contained no F-06 finding; §17.10 records that fact explicitly. A separate F-07 reference remains in the traceability table only as an unattributed historical reference: its source and issuance status have not been established, it is not attributed to the Haniyeh report, and V-44 is retained solely as a future contract scenario. The recorded DeepSeek review findings F-10 through F-14 and NEW-01 through NEW-14 are addressed and mapped; no DeepSeek F-01 through F-09 findings are asserted because none are present in the Issue #5 review record examined for this revision. All V-01 through V-70B entries remain future acceptance criteria, not tests claimed as executed; V-70A (hold mechanics) and V-70B (emergency-exit authorization) are separate scenarios with separate evidence and pass/fail outcomes. The earlier `RETURN FOR REVISION` disposition remains part of the review history. The latest Qwen AI documentation review dated November 26, 2026 returned `ACCEPT WITH CONDITIONS`: P2-03 required a written fail-closed exit policy when no approved sink exists or preservation fails; this documentation revision records that policy in section 17.12 and maps the bounded restricted-hold behavior to V-70A; emergency-exit authentication and audit prerequisites are independently mapped to V-70B. P3-03 is addressed by V-69's successful-persistence, verified-durable-acceptance, and restart-discoverability assertions. This conditional AI review does not constitute implementation validation, runtime testing, or an independently qualified third-party certification. Because prior architecture discussions were disclosed and public identity/qualification evidence was not supplied, the report is not treated as satisfying the issue's final independent-review requirement. This is not runtime validation, implementation approval, or a comprehensive audit. The transition and traceability tables are normative documentation aids, not executable tests or proof of implementation conformance. Implementation-specific decisions in section 15 remain open and require explicit design and review before implementation.

**Document status: DOCUMENTATION REVISION — AWAITING FINAL INDEPENDENT REVIEW**  
**Implementation authorization: NOT GRANTED**

