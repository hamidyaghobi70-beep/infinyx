# Process-Isolated Policy Terminal Commitment Contract

**Document ID:** INFINYX-ENG-003  
**Status:** Engineering contract for PR #32, Stage 1  
**Applies to:** `ProcessIsolatedPolicyEngine` terminal arbitration  
**Baseline:** PR #32 head `73971432ae9627178e195fefa670b41737b8e3be`

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
5. Later distinct causes must not cause a second terminal outcome or change the primary cause. Recording all later causes as additional provenance is tracked separately under P32-02; this Stage 1 contract does not claim that secondary provenance is already implemented.

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

INFINYX-ENG-002 §11.1.8 retains the epoch-based meaning of the existing public `PolicyEvaluationOptions.deadlineAt`. The monotonic shutdown-drain clock requirement does not silently redefine this policy-evaluation API.

## 7. Non-goals and safeguards

- No automatic retry, evaluator replay, or duplicate terminal bookkeeping.
- No change to `main`.
- No merge, release, deployment, or activation of Agent/Tool execution.
- CI success is workflow evidence only; it is not proof of security acceptance.
