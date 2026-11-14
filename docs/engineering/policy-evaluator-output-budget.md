# Policy Evaluator Output Budget Contract

**Document ID:** INFINYX-ENG-003  
**Status:** Proposed — documentation only  
**Scope:** B07, bounded child-process stdout/stderr handling  
**Parent baseline:** `fix/policy-diagnostic-redaction` at `76cf2535398a7fb317eae3b5bec9b92d5435b663`

## 1. Purpose

Prevent a policy evaluator child process from consuming unbounded parent-side I/O and event-processing resources by continuously writing to stdout or stderr. Output is diagnostic-only: it is never policy input, never retained as text, and never exposed through a public policy decision.

This contract does not claim to sandbox evaluator code or impose a complete CPU, filesystem, network, or operating-system resource limit.

## 2. Output budget

Each execution owns independent counters and immutable configured limits:

- `maxStdoutBytes`: maximum bytes accepted from stdout.
- `maxStderrBytes`: maximum bytes accepted from stderr.
- `maxTotalOutputBytes`: maximum combined bytes accepted from both streams.

Initial proposed defaults for review are 64 KiB per stream and 128 KiB combined. They are policy defaults, not yet implementation facts. Constructor validation must require safe, positive integers and enforce that the combined limit is not lower than either individual limit.

Count raw bytes using the chunk's byte length. Do not decode, concatenate, stringify, log, or retain output chunks. Count every observed byte, including bytes in the chunk that crosses a limit. Counter arithmetic must avoid unsafe-integer overflow.

## 3. Stream handling

Attach bounded data listeners to both child streams before the child can execute evaluator code. For each chunk:

1. Determine its byte length without decoding it.
2. Update the corresponding stream counter and total counter using overflow-safe comparisons.
3. If every applicable limit remains satisfied, discard the chunk.
4. If any limit is exceeded, atomically latch the output-limit violation once and request child cancellation through the existing coordinator.

Continue draining both streams until they close. Do not pause a stream after the limit is exceeded: leaving a pipe unread can block the child and interfere with termination. After the violation is latched, later chunks are drained and discarded without further counter growth or repeated stop requests.

A missing stream object is treated as zero bytes; stream errors must fail closed and must not expose raw error messages.

## 4. Candidate Freeze and Terminal Commitment

Candidate selection and terminal commitment remain separate.

- Candidate Freeze remains one-way. A later output event must never mutate an already frozen candidate.
- Output-limit violation is an independent execution-integrity veto, not a rewrite of the frozen candidate.
- Terminal Commitment is prohibited until the child `close` event has been observed and both output streams have completed their close lifecycle.
- At commitment, if an output-limit violation was latched before commitment, the committed outcome is `FAILED` with a fixed generic deny decision, regardless of whether the frozen candidate was `COMPLETED`, `DENIED`, or another ordinary result.
- If no candidate exists, existing abnormal-exit handling remains fail-closed.
- Once Terminal Commitment occurs, later observations cannot rewrite the committed record.

The parent must not infer ordering from timestamps across IPC and stdout/stderr. The close barrier is the authoritative boundary: process close is emitted after the child stdio streams have closed. All observed stream data must be accounted for before commitment.

## 5. Termination and capacity

On the first limit violation:

1. Latch `OUTPUT_LIMIT_EXCEEDED` exactly once.
2. Freeze a `FAILED` candidate only if no candidate has already been frozen.
3. Request cooperative cancellation where possible.
4. Use the existing hard-termination escalation path.
5. Keep the execution in the active-capacity map until child close is confirmed.

If close is not confirmed within the configured kill-wait period, resolve as `UNRESOLVED`; do not claim `STOPPED`, do not report cleanup as completed, and do not release capacity as though termination were confirmed. Existing unresolved shutdown behavior remains authoritative.

## 6. Public and operational reporting

Public policy decisions must use a fixed generic reason such as:

`Policy evaluator exceeded its output budget; access denied.`

Never include evaluator output, partial chunks, stderr, stdout, or stream error text in a public decision.

If operational telemetry is later added, it may contain only bounded metadata: execution ID, stream category, configured limit, and whether the limit was exceeded. It must not contain raw output or secrets. Telemetry callbacks must not change execution outcome.

## 7. Required tests

- stdout below its stream and total limits completes normally.
- stderr below its stream and total limits completes normally.
- stdout independently exceeds its limit.
- stderr independently exceeds its limit.
- combined output exceeds the total limit while each individual stream remains below its own limit.
- multiple small chunks are counted cumulatively by bytes.
- multibyte UTF-8 output is counted by bytes, not characters.
- a single chunk crossing the limit latches only one violation.
- output flood after an allow result but before child close prevents authorization at Terminal Commitment while preserving the frozen candidate.
- output flood before any result fails closed.
- both streams continue draining after violation.
- close confirmed produces a terminal failed record and releases capacity.
- close not confirmed produces unresolved status and retains capacity until actual close.
- no public decision or operational event contains evaluator-controlled output.
- simultaneous stdout/stderr threshold crossings trigger one stop sequence.

## 8. Acceptance criteria

B07 is not accepted until:

1. Both streams and their combined output are bounded by validated byte budgets.
2. No raw output is accumulated, decoded, or exposed.
3. Limit violation is latched exactly once.
4. Candidate Freeze remains immutable.
5. An output violation observed before the close barrier prevents an allow candidate from being committed.
6. Terminal Commitment occurs only after process and stdio closure are confirmed.
7. Unconfirmed termination remains `UNRESOLVED` and retains capacity.
8. All required tests pass on the exact proposed head SHA.

## 9. Explicit non-goals

This contract does not provide an OS sandbox, a hard CPU quota, a memory limit beyond the existing V8 old-space setting, filesystem isolation, network isolation, or protection against all forms of hostile child-process behavior. Those require separate controls and threat-model decisions.

## 10. Change control

This document is a proposal. It does not authorize merging, release, deployment, or changes to `main`. Runtime implementation must be performed on a separate branch, tested against this contract, and remain in a Draft pull request until explicitly accepted.
