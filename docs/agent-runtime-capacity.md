# Agent Runtime Capacity Contract

INFINYX Agent V1 admits at most **32 active tasks** per `AgentRuntime` instance (`MAX_ACTIVE_TASKS`). Admission is synchronous: the runtime checks the active-task count and inserts the accepted task into its active map without an intervening `await`.

## What consumes a slot

A slot remains occupied while the underlying `ModelPort` promise is unsettled. This includes:

- tasks currently executing;
- tasks whose caller has cancelled them but whose provider has not settled;
- tasks that have timed out but whose provider has not settled;
- tasks cancelled by runtime shutdown when the provider ignores the abort signal.

Returning an early `cancelled` or `timed_out` result does **not** imply that provider work has stopped. A task marked `executionState: "unresolved"` continues to consume its slot until the provider promise actually resolves or rejects. A provider that never settles can therefore retain a slot indefinitely. If all 32 slots are occupied, further valid requests are rejected with `status: "rejected"`, `code: "CAPACITY_EXCEEDED"` and a human-readable reason. Callers may retry after a running task truly settles; callers should not treat timeout/cancellation alone as slot release.

## When a slot is released

The runtime removes a task from its active map when its provider promise settles, including successful completion, provider error, late settlement after timeout/cancellation, or cancellation before provider invocation. The pre-invocation cancellation path does not start ModelPort work and settles without leaving a slot occupied.

## Operational limitation

There is no separate hard cap or forced termination mechanism for unresolved provider work. `AbortSignal` is cooperative. A non-cooperative provider can keep slots occupied indefinitely; at 32 unresolved tasks, the runtime applies backpressure by rejecting all additional tasks. Agent V1 does not enable a real provider by default: `DisabledModelPort` remains the default implementation. This capacity contract is process-local and per runtime instance; it is not a distributed/global concurrency limit.
