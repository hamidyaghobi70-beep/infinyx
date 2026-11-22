# Policy Cancellation and Runtime Containment

## Status

Proposed in pull request #57 on `security/shutdown-containment-hardening`; the changes have not been merged into `integration/infinyx-core-runtime-v1`. CI run #540 (`44968920671`) passed for commit `943e9121fea1f6fec33ac9b9fbcf32798bcc7f91`, including Ubuntu, macOS, Windows, and Dependency Security Audit. The current documentation-only head is `130c1e2e2ba6de804392ccafa7a626c2ca5a3fbf`; no PR-triggered workflow run has been returned for this new commit, so its CI is pending/unverified. Neither run #540 nor the documentation update exercises a real Linux cgroup v2 broker/boundary or a Windows Job Object/native launcher, and neither proves OS-level process-tree containment. Independent governance/security review remains pending. This document does not authorize merge, release, deployment, activation of Agent Runtime, or changes to Shutdown Timeout Contract v6.2.

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

ProcessIsolatedPolicyEngine loads a policy module in a dedicated Node.js child process. The module must be an absolute filesystem path or a local file URL without credentials, query, or fragment, and export either a default PolicyEngine, a named policyEngine, or a createPolicyEngine factory. Non-file schemes, remote file URL hosts, and decorated file URLs are rejected during construction.

The evaluator module location is trusted deployment configuration, not request data. Never derive moduleUrl from an HTTP request, tenant-controlled setting, or other user-writable source. An absolute path or local file URL is only a location check; it does not establish the integrity or trustworthiness of the code at that path. Deployments should pin the evaluator artifact through their normal build and release controls and ensure untrusted principals cannot replace it. The evaluator still executes with the child process's operating-system identity and permissions.

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

The child runs under the same operating-system user and inherits the host's general filesystem and network permissions unless the deployment environment imposes additional controls. A configurable V8 old-space ceiling is passed with max-old-space-size; this limits the V8 old generation, not total resident memory or native allocations. Wall-clock deadlines bound CPU time indirectly, but no OS CPU quota is configured.

**Termination currently targets only the direct child process.** The parent calls `child.kill("SIGKILL")` and treats the child's `close` event as confirmation that that child has exited. Neither operation proves that subprocesses or further descendants created by evaluator code have exited. A descendant may outlive the evaluator child, retain inherited resources, or continue external activity. Therefore, the runtime's UNRESOLVED state and capacity accounting describe the direct child only; they are not proof of process-tree containment.

The child can create subprocesses. This implementation does not create a POSIX process group for the evaluator, assign it to a Windows Job Object, or install a cgroup/container supervisor. It also does not claim filesystem isolation, network isolation, syscall filtering, CPU quotas, a memory hard limit, or descendant cleanup.

Worker Threads are not selected as the hard containment boundary because they share the parent process and are not an OS privilege boundary. Worker termination can stop a worker thread, but does not provide process-level fault separation.

For untrusted evaluators, deployment must establish and verify an OS-level containment boundary **before evaluator code begins executing**. That boundary must account for descendants, not just the direct child, and should include a dedicated low-privilege identity, restricted filesystem view, outbound network policy, process-tree supervision (for example, a correctly configured cgroup/container or Windows Job Object), and platform-specific resource limits. These controls are not implemented or verified by this change. Do not treat restarting the parent, observing the direct child's `close` event, or freeing its capacity slot as proof that all descendants have terminated.

## CoreEngine shutdown ordering

CoreEngine.stop() emits shutdownSignal immediately as a notification that shutdown has begun, closes protected-operation admission, and cancels admitted handlers. Modules must not release shared resources in response to this notification; resource cleanup belongs exclusively in the module stop() hook. CoreEngine waits for both policy shutdown and admitted-handler drain before invoking that hook. Policy shutdown has its own finite deadline (configurable with policyShutdownTimeoutMs, default 5 seconds). If that deadline expires, CoreEngine enters UNRESOLVED and does not begin module cleanup; a later explicit stop call can retry.

For an arbitrary in-process PolicyEngine delegate, FailClosedPolicyEngine requests cancellation of active evaluations, awaits the delegate's optional shutdown() hook, and then awaits settlement of the underlying evaluation promises. Cancellation freezes the authorization result as deny, but does not itself terminate JavaScript execution. If a non-cooperative delegate never settles, CoreEngine's policy shutdown deadline expires and the Core lifecycle remains UNRESOLVED. Hard termination evidence is available only when the evaluator is executed through the child-process adapter.

The production composition root uses createProductionCoreEngine(), which always sets requireProcessIsolation: true. Until a verified OS-level process-tree supervisor is integrated, this factory now rejects **all** supplied custom PolicyEngine instances, including ProcessIsolatedPolicyEngine. The shipped server currently uses the built-in default-deny policy, so this restriction does not change its behavior. Regression tests cover rejection of both in-process and child-process custom evaluators. This is an intentional production gate: direct-child Node.js isolation is not represented as whole-tree containment.

CoreEngine remains a lower-level public API and can still be constructed directly with a custom in-process PolicyEngine when requireProcessIsolation is omitted or false, or with ProcessIsolatedPolicyEngine for direct-child isolation only. Those lower-level APIs do not establish process-tree containment. Library consumers and alternate composition roots must not use them for hostile evaluator code until a supervisor has been integrated and verified. The API does not infer whether arbitrary policy code is trusted.

## Shutdown signal semantics

The module-context shutdownSignal is emitted synchronously at shutdown start. It is an early notification that new protected work is no longer admitted, not permission to release resources still needed by already-admitted handlers. Modules may stop accepting work and request cooperative cancellation in response, but resource release belongs in the module stop() hook, which CoreEngine does not invoke until policy shutdown and protected-handler drain have completed.

## Child-process IPC integrity

The parent accepts policy-runner progress and result messages only when they carry a per-execution random response token. The child runner captures its IPC sender before importing evaluator-controlled code and uses that closure-held sender for authenticated messages. This prevents an evaluator from forging a result by calling or monkey-patching the shared `process.send` API, including by attempting to intercept the runner's progress message. Messages without the matching token are ignored and the normal timeout/termination path remains fail-closed.

This is protocol hardening within the child-process boundary, not a claim that a Node.js child process is a complete hostile-code sandbox. Process isolation still requires deployment-level OS controls, and the parent remains responsible for enforcing deadlines and validating the final decision shape.

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

## Production evaluator gate

The strict production factory intentionally rejects every custom policy evaluator until the repository has a supervisor that can create the evaluator inside an OS-managed process-tree boundary before evaluator code runs and can verify that the complete boundary is empty after termination. This includes evaluators that run in a Node.js child process: the current child adapter still terminates and accounts for only the direct child. The lower-level CoreEngine and ProcessIsolatedPolicyEngine APIs remain available for tests and controlled trusted use, but they must not be mistaken for hostile-code containment.

## Platform verification

The process lifecycle tests are intended to run on Linux, macOS, and Windows using the repository's Node.js 22.23.4 CI matrix. A platform is not considered verified until its actual CI job completes successfully.
