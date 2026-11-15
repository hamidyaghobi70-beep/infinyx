# Agent Runtime Capacity Contract

INFINYX Agent V1 admits at most **32 active tasks** per `AgentRuntime` instance (`MAX_ACTIVE_TASKS`). Admission is synchronous: the runtime validates the request, checks the active-task count, and inserts an accepted task into its active map without an intervening `await`.

## What consumes a slot

A slot remains occupied while the underlying `ModelPort` promise is unsettled. This includes:

- tasks currently executing;
- tasks whose caller has cancelled them but whose provider has not settled;
- tasks that have timed out but whose provider has not settled;
- tasks cancelled by runtime shutdown when the provider ignores the abort signal.

Returning an early `cancelled` or `timed_out` result does **not** imply that provider work has stopped. A task marked `executionState: "unresolved"` continues to consume its slot until the provider promise actually resolves or rejects. A provider that never settles can therefore retain a slot indefinitely. If all 32 slots are occupied, further valid requests are rejected with `status: "rejected"`, `code: "CAPACITY_EXCEEDED"` and a human-readable reason. Callers may retry after a running task truly settles; callers should not treat timeout/cancellation alone as slot release.

## Execution-state meanings

`AgentExecutionState` describes runtime tracking, not just the result already returned to the caller:

- `"running"`: the provider promise is pending and no early cancellation/timeout result has been returned;
- `"unresolved"`: cancellation or timeout has been returned, but the provider promise is still pending and continues to hold capacity;
- `"settled"`: the provider promise has settled, or provider invocation was skipped because cancellation/shutdown won before the provider microtask.

Therefore, `"settled"` does not by itself prove that a provider call began. In particular, cancellation before provider invocation is reported as settled because no external provider operation was started. This state is distinct from `"unresolved"`, where provider work may still be running despite the caller having received a result.

## When a slot is released

The runtime removes a task from its active map when its provider promise settles, including successful completion, provider error, late settlement after timeout/cancellation, or cancellation before provider invocation. The pre-invocation cancellation path does not start ModelPort work and does not leave an unresolved provider operation.

## Operational limitation

There is no separate hard cap or forced termination mechanism for unresolved provider work. `AbortSignal` is cooperative. A non-cooperative provider can keep slots occupied indefinitely; at 32 unresolved tasks, the runtime applies backpressure by rejecting all additional tasks. Agent V1 does not enable a real provider by default: `DisabledModelPort` remains the default implementation. This capacity contract is process-local and per runtime instance; it is not a distributed/global concurrency limit.

## Regression coverage

The AgentRuntime tests cover synchronous capacity reservation, release after successful provider settlement, and release after provider errors. Cancellation tests cover pre-invocation cancellation, cancellation/timeout while a provider remains unresolved, capacity retention for non-cooperative providers, and capacity release after late provider settlement.
