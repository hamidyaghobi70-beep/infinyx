# Policy Cancellation and Runtime Containment

## Status

Proposed in pull request #57 on `security/shutdown-containment-hardening`; the changes have not been merged into `integration/infinyx-core-runtime-v1`. CI verification completed on Linux, macOS, and Windows for the current PR head. Independent governance/security review remains pending. This document does not authorize merge, release, deployment, activation of Agent Runtime, or changes to Shutdown Timeout Contract v6.2.

## Cancellation contract

Policy evaluation accepts an optional caller AbortSignal, an optional parent AbortSignal, and an absolute parent deadline in epoch milliseconds. The in-process fail-closed wrapper:

- rejects invalid or unsafe request snapshots before invoking the evaluator;
- propagates a combined cancellation signal to the evaluator;
- applies the earlier of its configured timeout and the supplied parent deadline;
- returns a deny decision when caller cancellation, parent cancellation, or timeout wins;
- freezes the returned decision as a detached immutable value; and
- removes its timer and abort listeners after settlement.

This in-process wrapper is cooperative only. A delegate that ignores AbortSignal can continue executing after the wrapper returns.

## Process containment contract

ProcessIsolatedPolicyEngine loads a policy module in a dedicated Node.js child process. The module must be an absolute filesystem path or file URL and export either a default PolicyEngine, a named policyEngine, or a createPolicyEngine factory.

The parent process:

- sends only the validated policy request and bounded deadline over IPC;
- does not pass the parent's environment variables to the child;
- bounds active child processes with maxConcurrent;
- sends cooperative cancellation first;
- requests hard process termination after the configured grace interval;
- waits for the child close event before releasing its capacity slot;
- returns UNRESOLVED and retains the capacity slot if process termination cannot be confirmed;
- exposes activeCount, unresolvedCount, availableCapacity, and maxConcurrent through a read-only capacitySnapshot (plus unresolvedExecutionCount); and
- freezes the first terminal candidate so late messages or cancellation cannot rewrite it.

No automatic retry is performed. No external side-effect rollback is attempted.

## Security boundary and limitations

A child process is a stronger execution-termination boundary than Promise.race or AbortSignal alone. It is not a complete operating-system security sandbox.

The child runs under the same operating-system user and inherits the host's general filesystem and network permissions unless the deployment environment imposes additional controls. A configurable V8 old-space ceiling is passed with max-old-space-size; this limits the V8 old generation, not total resident memory or native allocations. Wall-clock deadlines bound CPU time indirectly, but no OS CPU quota is configured. The child can also attempt to create its own subprocesses. This implementation does not claim filesystem isolation, network isolation, syscall filtering, CPU quotas, or a memory hard limit.

Worker Threads are not selected as the hard containment boundary because they share the parent process and are not an OS privilege boundary. Worker termination can stop a worker thread, but does not provide process-level fault separation.

For untrusted evaluators, deployment must add OS-level controls appropriate to the threat model, such as a dedicated low-privilege identity, restricted filesystem view, outbound network policy, process-tree supervision, and platform-specific resource limits. These controls are not implemented or verified by this change.

## CoreEngine shutdown ordering

CoreEngine.stop() emits shutdownSignal immediately as a notification that shutdown has begun, closes protected-operation admission, and cancels admitted handlers. Modules must not release shared resources in response to this notification; resource cleanup belongs exclusively in the module stop() hook. CoreEngine waits for both policy shutdown and admitted-handler drain before invoking that hook. Policy shutdown has its own finite deadline (configurable with policyShutdownTimeoutMs, default 5 seconds). If that deadline expires, CoreEngine enters UNRESOLVED and does not begin module cleanup; a later explicit stop call can retry.

For an arbitrary in-process PolicyEngine delegate, FailClosedPolicyEngine requests cancellation of active evaluations, awaits the delegate's optional shutdown() hook, and then awaits settlement of the underlying evaluation promises. Cancellation freezes the authorization result as deny, but does not itself terminate JavaScript execution. If a non-cooperative delegate never settles, CoreEngine's policy shutdown deadline expires and the Core lifecycle remains UNRESOLVED. Hard termination evidence is available only when the evaluator is executed through the child-process adapter.

When untrusted policy code is supplied, configure CoreEngine with requireProcessIsolation: true. This rejects a custom in-process PolicyEngine and requires a ProcessIsolatedPolicyEngine. This is an explicit composition-time enforcement option; it does not infer whether arbitrary policy code is trusted.

## Shutdown signal semantics

The module-context shutdownSignal is emitted synchronously at shutdown start. It is an early notification that new protected work is no longer admitted, not permission to release resources still needed by already-admitted handlers. Modules may stop accepting work and request cooperative cancellation in response, but resource release belongs in the module stop() hook, which CoreEngine does not invoke until policy shutdown and protected-handler drain have completed.

## Runtime outcomes

The detailed process API reports lifecycle, terminal outcome, runtime status, cleanup status, stop reason, and whether the terminal candidate was frozen.

An allow decision is returned only when the child process has exited successfully. If termination cannot be confirmed, the result is deny and the record is UNRESOLVED. The process slot remains occupied until a close event is observed. Operators can inspect capacitySnapshot to distinguish active work from unresolved children; unresolvedCount is included in activeCount, and availableCapacity is computed from all occupied slots. When the child eventually emits close, both the active and unresolved counts are decremented. These counters are in-process observations, not durable telemetry or an automatic recovery mechanism.

## Operational response to unresolved capacity

The runtime exposes an in-process capacity snapshot, but it does not currently publish durable metrics, emit an external alert, or restart child processes automatically. The host application or deployment supervisor must provide those operational controls.

Recommended operator response:

1. Alert when unresolvedCount is non-zero. Treat availableCapacity reaching zero as a service-capacity incident; keep policy decisions fail-closed and reject or shed new protected work rather than bypassing the process limit.
2. Preserve the capacity snapshot and correlated execution identifiers in external logs/telemetry before attempting recovery. The snapshot is observational and is not a durable source of truth.
3. Allow the runtime to observe a child close event. Only that event releases the corresponding slot. Do not delete or decrement an unresolved slot manually, and do not launch replacement children to compensate for unresolved slots.
4. If the child never closes, use a deployment-level supervisor to isolate and terminate the complete managed process tree (for example, a container/cgroup or Windows Job Object configured for descendant cleanup). Verify those semantics for the target platform before relying on them. Restarting only the parent process is not sufficient evidence that orphaned children or their descendants have terminated.
5. Before restarting service traffic, verify that the old execution boundary is gone, the new parent has a clean capacity state, and any external side effects are reconciled by the owning application. This runtime does not roll back external effects and does not automatically retry policy work.

This is an operational recommendation, not an implemented recovery controller. No administrative API currently clears unresolved entries, and none should be added unless it is backed by verifiable OS-level process termination evidence. Until deployment supervision is configured and tested, unresolved capacity exhaustion remains a manual availability incident.

## Platform verification

The process lifecycle tests are intended to run on Linux, macOS, and Windows using the repository's Node.js 22.23.4 CI matrix. A platform is not considered verified until its actual CI job completes successfully.
