# Process-Isolated Policy Terminal Commitment Contract

**Document ID:** INFINYX-ENG-003  
**Status:** Engineering contract for PR #32, Stage 1  
**Applies to:** `ProcessIsolatedPolicyEngine` terminal arbitration  
**Baseline:** PR #32 audited head `9ee5303ae30eb14d5c425e203eae687779f16da0`

## 1. Purpose

Define deterministic arbitration between a frozen policy outcome candidate, cancellation/timeout vetoes, and output-stream failures before the child process reaches its terminal `close` event.

This contract does not authorize merge, release, deployment, or changes to `main`.

## 2. Three distinct phases

1. **Outcome Candidate Selection:** a child result or a fail-closed runtime condition proposes an outcome and decision.
2. **Candidate Freeze:** the selected candidate becomes immutable. A later event must not mutate or replace that candidate.
3. **Terminal Commitment:** the coordinator commits exactly one terminal record from the frozen candidate and any stop condition accepted before commitment. The child `close` event is the sole commitment boundary for a resolved process execution. `AUTHORIZED` may be emitted only after that commitment has selected `COMPLETED`.

Candidate Freeze is not Terminal Commitment. A caller/parent cancellation or timeout accepted after Candidate Freeze but before `close` must still prevent authorization.

## 3. Primary stop arbitration

For PR #32 Stage 1, **the first accepted stop condition is the primary terminal cause**. The arbitration is based on event acceptance order, not on a fixed priority between output failures and cancellation/timeout.

The accepted stop condition is one of:

- caller cancellation;
- parent cancellation;
- policy timeout;
- runtime shutdown;
- output limit exceeded;
- output stream failure.

The rules are:

1. If a cancellation/timeout veto is accepted first, it becomes the primary stop condition. A later output-stream failure is not allowed to replace it.
2. If an output failure is accepted first, it remains the primary stop condition. A later cancellation/timeout cannot replace its terminal outcome, decision, or primary `stopReason`.
3. If a stop candidate with a `stopReason` was already frozen, a later cancellation/timeout cannot replace it.
4. If a non-stop candidate (including an allow candidate) was frozen first, the first accepted stop condition may veto that candidate before Terminal Commitment.
5. Later distinct causes must not cause a second terminal outcome or change the primary cause. P32-02 implements and tests immutable, deduplicated secondary-cause provenance for distinct causes observed before Terminal Commitment; this provenance does not change the primary cause or terminal result.

This is a first-accepted-stop rule. It is deliberately **not** “output failure always wins” and **not** “cancellation always wins.”

## 4. Terminal outcome mapping

- A primary `CALLER_CANCELLED`, `PARENT_CANCELLED`, or `RUNTIME_SHUTDOWN` produces `CANCELLED`.
- A primary `POLICY_TIMEOUT` produces `TIMED_OUT`.
- A primary `OUTPUT_LIMIT_EXCEEDED` or `OUTPUT_STREAM_FAILED` produces `FAILED`.
- If no stop condition is accepted, the frozen candidate remains subject to child-exit validation. An abnormal exit cannot produce `AUTHORIZED`; it fails closed.
- The committed record's `stopReason` identifies the primary accepted stop condition.

## 5. Deterministic race-test requirements

The test suite must force both event orders without relying on arbitrary sleeps:

### 5.1 Output failure before cancellation

Use an evaluator fixture that exceeds the stdout budget. The engine's synchronous `STOP_REQUESTED` observer acts as a barrier and aborts the caller immediately. Expected primary result:

- `outcome === "FAILED"`;
- `stopReason === "OUTPUT_LIMIT_EXCEEDED"`;
- deny decision uses the output-budget failure message;
- `AUTHORIZED` is never emitted.

### 5.2 Cancellation before output failure

Use an evaluator fixture that returns an allow candidate but emits output after the parent acknowledges finalization. The synchronous `FINALIZING` observer aborts the caller before that acknowledgement. Expected primary result:

- `outcome === "CANCELLED"`;
- `stopReason === "CALLER_CANCELLED"`;
- decision is deny;
- `AUTHORIZED` is never emitted.

Both tests must assert the exact outcome, decision, primary stop reason, and absence of `AUTHORIZED`.

## 6. Relationship to INFINYX-ENG-002

INFINYX-ENG-002 §11.2.4 requires the first accepted cancellation cause to remain the immutable primary cause and later distinct cancellation causes—including runtime shutdown—to be preserved as additional provenance events. This Stage 1 contract fixes the primary-cause arbitration for PR #32. P32-02 must implement and test the additional-provenance requirement without changing the primary terminal result defined here.

INFINYX-ENG-002 §11.2.9 retains the epoch-based meaning of the existing public `PolicyEvaluationOptions.deadlineAt`. The monotonic shutdown-drain clock requirement does not silently redefine this policy-evaluation API.

## 7. Non-goals and safeguards

- No automatic retry, evaluator replay, or duplicate terminal bookkeeping.
- No change to `main`.
- No merge, release, deployment, or activation of Agent/Tool execution.
- CI success is workflow evidence only; it is not proof of security acceptance.


## P32-02 — Immutable stop provenance

The terminal record now carries optional `stopProvenance`: an immutable, deduplicated array of `{ code, message }` entries in first-observed order. The first entry is the primary stop cause and must match `stopReason`; later distinct causes are retained without changing the primary outcome, decision, or terminal bookkeeping. Messages are generated only from the engine's fixed `stopMessage` mapping; arbitrary signal reasons and caller-controlled text are never copied into the record.

Provenance is captured only before Terminal Commitment. Once the execution is committed or returned as unresolved, its record is immutable and later observations cannot rewrite it. Repeated observations of the same stop code do not create duplicate entries.

The acceptance tests cover both:
- `POLICY_TIMEOUT` followed by `RUNTIME_SHUTDOWN`, with shutdown initiated synchronously from the timeout stop notification;
- `CALLER_CANCELLED` followed by `RUNTIME_SHUTDOWN`, where shutdown is initiated while the caller signal is already aborted.

Both assert that the primary cause remains unchanged, the later cause is retained, and the execution record's provenance array and entries are frozen. This implements the relevant first-cause/additional-provenance rule in INFINYX-ENG-002 §11.2.4 for causes observed before terminal commitment; it does not claim durable audit storage.


## P32-04 — Child error after unresolved commitment

The `finishUnresolved` path commits an immutable `UNRESOLVED` record while retaining the active execution entry until the operating-system child actually emits `close`. A subsequent child `error` event must not replace that record or create a second terminal candidate. The close handler must still remove the retained active entry.

The acceptance test forces termination attempts to report failure, waits for the `UNRESOLVED` barrier, emits a controlled late `error` event, then restores real process termination and waits for `close`. It asserts the original unresolved outcome remains unchanged, the active reference is retained before close, and the registry count returns to zero only after close. No production-code change is required for this finding unless the test exposes a defect.


## P32-05 — Unified stop-cause arbitration

Cancellation/timeout and output-stop handlers now delegate cause acceptance to one coordinator-local `acceptStopCause` function. It owns the single rule for:
- rejecting observations after terminal commitment;
- recording each distinct cause once in first-observed order;
- assigning `stopReason` only once to the primary cause;
- distinguishing primary, secondary, and post-commit observations.

Only a `PRIMARY` disposition may freeze/veto a candidate or initiate cancellation/termination. A `SECONDARY` disposition updates provenance only; it cannot change the candidate, primary reason, outcome, decision, or trigger duplicate termination bookkeeping. Both stop paths therefore use the same acceptance rule, while retaining their specific outcome mapping (cancel/timeout versus output failure).

The P32-01 race tests and P32-02 provenance tests are the behavioral regression coverage for both orderings and secondary-cause retention. This is a focused refactor; no retry or additional process lifecycle is introduced.


## P32-07 — Epoch deadline clock-domain compatibility

`PolicyEvaluationOptions.deadlineAt` remains an epoch-millisecond wall-clock value. The coordinator computes the remaining duration against `Date.now()` and enforces the actual process timeout with its own timer. The child runner forwards the effective epoch-millisecond deadline hint unchanged to the evaluator; it does not use that value as a monotonic timer or convert it to `performance.now()`.

This preserves the existing public API clock domain and keeps the shutdown-drain monotonic deadline separate. The checked INFINYX-ENG-002 revision at commit `555facf859d044368af145cc621af810e72e03db` states this compatibility rule in its clock-domain contract (normative §11.2.9); that revision does not contain a §11.1.8 heading, so this record does not mislabel the reference. This is consistent with the requested §11.1.8 principle: do not silently reinterpret the existing epoch-based `deadlineAt`.
