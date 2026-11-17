# Issue #29 — Windows Job Object Launcher Design

Status: **DESIGN PROPOSAL — NOT IMPLEMENTED / NOT SECURITY-APPROVED**

## 1. Context and constraints

The current `ProcessIsolatedPolicyEngine` launches `policy-evaluator-child.ts` with Node `fork()` and relies on the Node IPC channel for `evaluate`, `cancel`, progress, result, and `finalize` messages. The parent also observes stdout/stderr and does not treat direct-child exit as proof that descendants have exited.

Windows currently reports `DIRECT_CHILD_ONLY`. This design must preserve the evaluator protocol, output limits, cancellation arbitration, and the invariant that capacity is not released while containment cleanup is unresolved.

Constraints: no third-party native dependency; no Agent/Tool activation; no merge, release, or deployment; no claim that Job Objects are a complete sandbox.

## 2. Proposed topology

Use a small in-repository native Windows launcher executable, compiled from reviewed C source with the Microsoft toolchain on Windows CI. The Node policy engine starts the launcher, not the evaluator directly. The launcher owns one unnamed Job Object and is the only process that owns its Job handle.

1. Create an unnamed Job Object and configure `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.
2. Do not enable `JOB_OBJECT_LIMIT_BREAKAWAY_OK` or `JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK`; do not pass `CREATE_BREAKAWAY_FROM_JOB`.
3. Create the evaluator Node process with `STARTUPINFOEX` and `PROC_THREAD_ATTRIBUTE_JOB_LIST`, supplying the Job handle as part of process creation. Also request `CREATE_SUSPENDED`; do not allow evaluator code to run before creation-time Job association is established.
4. Resume the evaluator's primary thread only after successful `CreateProcessW` return and validation of the process/thread handles.
5. If Job configuration, process creation, Job association, handle validation, or thread resume fails, terminate any created process, wait for its exit, close handles, and return a non-allow failure status. Never fall back to an uncontained direct child.
6. The launcher remains alive while the evaluator runs. On evaluator exit, it waits for the Job to become empty and reports the final process exit and cleanup status to the Node parent. On launcher termination, closing its last Job handle invokes `KILL_ON_JOB_CLOSE` for assigned members.

Creation-time association is preferred over `CreateProcess(CREATE_SUSPENDED)` followed by a separate `AssignProcessToJobObject` call: it avoids a runnable interval before assignment and removes the ordinary post-create/pre-assignment crash window. The implementation must still treat failure to create or resume as fail-closed.

## 3. Preserve the current Node IPC contract

The current evaluator protocol is Node IPC, not a text protocol. The first implementation experiment must prove that the native launcher can preserve the parent's IPC channel end-to-end while starting the evaluator as its child. The launcher's process creation must explicitly inherit only the required standard handles and the IPC transport handle; it must not leak unrelated inheritable handles.

Required proof before integration:
- Parent `child.send({ type: 'evaluate', ... })` reaches the evaluator unchanged.
- Evaluator `process.send()` messages (`started`, `result`, `error`, `cancelled`) reach the parent unchanged.
- Parent cancellation and `finalize` reach the evaluator.
- stdout/stderr remain independently observable and subject to existing byte limits.
- IPC disconnect and evaluator/launcher exit ordering do not produce false successful completion.

If Windows Node IPC cannot be safely passed through by the native launcher, stop and redesign the transport explicitly (for example, a dedicated named-pipe control channel with a reviewed ACL and a bounded protocol). Do not silently replace IPC with stdout/stderr or parse Node's private IPC framing.

## 4. Process-tree semantics and limitations

Windows Job Objects normally associate child processes created by `CreateProcess` with the Job unless breakaway is enabled. The implementation must not enable either breakaway flag. Job membership and active-process count must be queried until the Job is empty; the launcher's exit code alone is not sufficient evidence.

Job Objects are not a complete security sandbox. Microsoft documents exceptions to default membership, including processes created through `Win32_Process.Create`; a hostile evaluator may also have access to brokered process-creation paths. This design therefore establishes an OS process-lifecycle boundary for supported creation paths, not isolation of filesystem, network, credentials, kernel attack surface, or all possible process creation mechanisms.

## 5. Launcher crash and handle ownership

The launcher owns the Job handle and must not duplicate it into the evaluator or descendants. The Job handle must be non-inheritable. A normal launcher crash closes its handle; if the evaluator was successfully associated, `KILL_ON_JOB_CLOSE` terminates Job members.

The public API documentation describes `PROC_THREAD_ATTRIBUTE_JOB_LIST` as assigning the listed Jobs during process creation and says the child is assigned before its initial thread is allowed to run. However, the public contract does not fully specify every interrupted-`CreateProcessW` failure outcome if the launcher is terminated while the system call itself is still in progress. Do not claim a formally proven no-orphan guarantee for that narrow interruption window without authoritative confirmation and fault-injection evidence. Record it as an explicit residual risk and test the observable behavior.

## 6. Compatibility and fail-closed policy

- Require Windows 10 or later / Windows Server 2016 or later for `PROC_THREAD_ATTRIBUTE_JOB_LIST`.
- If the attribute is unavailable, Job creation/configuration fails, assignment is rejected due to an incompatible outer Job, or the launcher binary is absent/invalid, report containment unavailable and deny policy authorization. Do not fall back to `DIRECT_CHILD_ONLY` while presenting the operation as contained.
- Windows CI must compile the launcher from source and run integration tests on the exact PR head.
- Linux/macOS continue using the separately labeled `POSIX_PROCESS_GROUP_BEST_EFFORT` path; this Windows design does not upgrade POSIX guarantees.

## 7. Required implementation and test gates

1. Native unit tests: Job creation/configuration, no-breakaway flags, command-line quoting, handle inheritance allow-list, process creation failure, resume failure, and all cleanup paths.
2. Integration test: evaluator spawns a grandchild with ordinary `CreateProcess`; terminate the launcher and prove both evaluator and grandchild exit.
3. Cancellation test: parent requests cancellation; launcher closes/terminates the Job; no allow result is committed.
4. Job membership test: query Job accounting/process list and wait for zero active processes before reporting cleanup complete or releasing capacity.
5. Assignment-failure test: force an incompatible outer Job or injected API failure; evaluator must never execute and authorization must deny.
6. Launcher-crash tests at controlled checkpoints: before Job creation, after Job configuration, around `CreateProcessW`, after successful creation but before resume, and after resume. Record any point where the OS contract cannot provide a deterministic cleanup guarantee.
7. IPC compatibility tests for all message directions and stdio output limits.
8. Windows CI compiles with the supported MSVC toolchain and runs all native/integration tests. The exact tested commit SHA must match the PR head.
9. Independent security review of native code, handle ownership, process creation, command-line/environment handling, and all claims.

## 8. Implementation decision

Proceed first with a minimal native launcher proof-of-concept and IPC pass-through experiment. Do not integrate it into the production policy engine until the IPC behavior, failure cleanup, and Windows CI gates above are demonstrated. Keep the capability label as `DIRECT_CHILD_ONLY` until all Windows acceptance tests pass and independent review is complete.

## References

- Microsoft: [UpdateProcThreadAttribute / PROC_THREAD_ATTRIBUTE_JOB_LIST](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)
- Microsoft: [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- Microsoft: [AssignProcessToJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject)
- Microsoft: [Nested Jobs](https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs)