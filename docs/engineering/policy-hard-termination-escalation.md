# INFINYX Engineering Contract: Policy Child Hard-Termination Escalation

**Document ID:** INFINYX-ENG-004  
**Status:** Draft — implementation review required  
**Scope:** Direct child-process termination for the isolated policy evaluator

## 1. Purpose

A cancellation request must not assume that a child process has stopped. The evaluator may ignore its cooperative cancellation signal or the operating-system's graceful termination signal. The parent must use a forceful escalation path and must treat the child's `close` event—not a successful `kill()` return value—as proof that the process and its stdio streams have closed.

## 2. Required termination sequence

1. Freeze the terminal candidate and prohibit any later cancellation from rewriting it.
2. Send the cooperative IPC cancellation message when the child IPC channel is available.
3. Wait `terminationGraceMs` before requesting OS termination.
4. Send `SIGTERM` to the direct child process.
5. Wait `killWaitMs` for the child's `close` event.
6. If the child remains open, send `SIGKILL` to the direct child process.
7. Wait a further `killWaitMs` for the child's `close` event.
8. If `close` is still not observed, commit an `UNRESOLVED` result, retain the active-capacity slot, and reject new work when capacity is exhausted.

A `kill()` return value, IPC disconnection, timer expiry, or signal request is not proof of termination.

## 3. Platform behavior

- On POSIX systems, `SIGTERM` may be caught or ignored; `SIGKILL` is the forceful escalation.
- On Windows, Node's signal handling is implemented through process termination semantics; the parent still waits for the same `close` barrier before releasing capacity.
- If the platform or runtime cannot confirm close after the forceful request, the result remains `UNRESOLVED`.

## 4. Resource and authorization invariants

- No `AUTHORIZED` event may be emitted before process close and final output/exit validation.
- Stdout and stderr remain observed until close; output-budget violations continue to veto an allow.
- Active capacity is released only in the close handler.
- An unresolved process continues to occupy capacity. There is no automatic retry or false success.
- Public failure reasons remain generic; signal errors and child diagnostics are not exposed.

## 5. Explicit limitation

This contract escalates termination of the direct evaluator child. It does not provide an OS sandbox or guarantee termination of arbitrary descendants spawned by the evaluator. A descendant that inherits stdio handles may delay the parent's stdio-close barrier; in that case the safe outcome is `UNRESOLVED` with capacity retained. Process-group containment on POSIX and Windows Job Object containment require a separate design and verification stage.

## 6. Acceptance evidence

- A fixture that catches and ignores `SIGTERM` is terminated through the escalation path before its independent fallback exit.
- The evaluator result is not returned as stopped until the child `close` event is observed.
- Capacity is released only after close.
- If close cannot be observed after the forceful wait, the outcome is `UNRESOLVED` and capacity remains occupied.
- CI must pass typecheck, build, unit/API tests, process lifecycle tests, and dependency audit on supported operating systems.

## 7. Governance

This is a draft engineering contract and implementation proposal. It does not authorize merge, release, deployment, changes to `main`, or enabling Agent/Tool execution.
