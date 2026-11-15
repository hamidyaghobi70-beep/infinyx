# Policy Cancellation and Runtime Containment

## Status

Implementation integrated on `integration/infinyx-core-runtime-v1`; CI verification completed on Linux, macOS, and Windows. Independent governance/security review remains pending. This document does not authorize merge, release, deployment, activation of Agent Runtime, or changes to Shutdown Timeout Contract v6.2.

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
- returns UNRESOLVED and retains the capacity slot if process termination cannot be confirmed; and
- freezes the first terminal candidate so late messages or cancellation cannot rewrite it.

No automatic retry is performed. No external side-effect rollback is attempted.

## Security boundary and limitations

A child process is a stronger execution-termination boundary than Promise.race or AbortSignal alone. It is not a complete operating-system security sandbox.

The child runs under the same operating-system user and inherits the host's general filesystem and network permissions unless the deployment environment imposes additional controls. A configurable V8 old-space ceiling is passed with max-old-space-size; this limits the V8 old generation, not total resident memory or native allocations. Wall-clock deadlines bound CPU time indirectly, but no OS CPU quota is configured. The child can also attempt to create its own subprocesses. This implementation does not claim filesystem isolation, network isolation, syscall filtering, CPU quotas, or a memory hard limit.

Worker Threads are not selected as the hard containment boundary because they share the parent process and are not an OS privilege boundary. Worker termination can stop a worker thread, but does not provide process-level fault separation.

For untrusted evaluators, deployment must add OS-level controls appropriate to the threat model, such as a dedicated low-privilege identity, restricted filesystem view, outbound network policy, process-tree supervision, and platform-specific resource limits. These controls are not implemented or verified by this change.

## CoreEngine shutdown ordering

CoreEngine.stop() asks the policy runtime to stop accepting work before module cleanup begins. With ProcessIsolatedPolicyEngine, shutdown waits for each child process to close; if any process remains UNRESOLVED, shutdown rejects and CoreEngine does not begin module cleanup. A later explicit stop call can retry after the process has actually closed.

For an arbitrary in-process PolicyEngine delegate that does not implement shutdown(), FailClosedPolicyEngine can request cooperative cancellation but cannot prove that a non-cooperative delegate has stopped. Hard termination evidence is available only when the evaluator is executed through the child-process adapter.

## Runtime outcomes

The detailed process API reports lifecycle, terminal outcome, runtime status, cleanup status, stop reason, and whether the terminal candidate was frozen.

An allow decision is returned only when the child process has exited successfully. If termination cannot be confirmed, the result is deny and the record is UNRESOLVED. The process slot remains occupied until a close event is observed.

## Platform verification

The process lifecycle tests are intended to run on Linux, macOS, and Windows using the repository's Node.js 22.23.4 CI matrix. A platform is not considered verified until its actual CI job completes successfully.
