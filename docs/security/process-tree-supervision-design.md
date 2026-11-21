# Process-Tree Supervision: Required Runtime Contract

**Status:** design specification; no OS-level supervisor is implemented by this document.

## Problem

The current policy runtime starts `policy-evaluator-child` with Node's `fork()` and terminates that direct child with `child.kill("SIGKILL")`. The child's `close` event proves that the direct child has closed its IPC/stdio handles; it does not prove that subprocesses or further descendants have exited.

Consequently, the current `UNRESOLVED` state, active-capacity accounting, and shutdown behavior describe the direct child only. They must not be represented as whole-process-tree containment.

## Security invariant

Untrusted evaluator code MUST NOT execute until the OS has placed the evaluator process inside a containment boundary whose membership and termination semantics are controlled by the supervisor.

The supervisor MUST be responsible for both process creation and containment establishment, or use a paused bootstrap/native launcher that cannot execute evaluator code before containment is established. Attaching a normally running child after `fork()` is not sufficient: it creates a race in which evaluator code can spawn descendants before assignment.

If containment cannot be established or verified, the evaluator MUST NOT be started. The request MUST fail closed.

## Required adapter boundary

The production runtime should depend on an injected process-tree supervisor abstraction, not implement platform-specific termination inline in the policy engine. The abstraction must own the complete launch handshake and expose semantics equivalent to:

- **launchContained:** create the runner within the containment boundary and return a handle only after containment membership is confirmed and before evaluator code is allowed to load.
- **send / IPC:** preserve the existing authenticated parent-child message protocol without exposing the response capability to evaluator-controlled code.
- **terminateTree:** request termination of every process in the boundary, not merely the direct child.
- **waitForTreeExit:** resolve only after the supervisor can verify that the boundary contains no remaining processes.
- **dispose:** release supervisor resources only after tree exit has been confirmed; failure to verify exit must retain the unresolved state and occupied capacity.

The exact TypeScript types and ownership rules should be finalized before wiring this abstraction into `ProcessIsolatedPolicyEngine`. A supervisor must not offer a boolean “killed” result that merely means a termination request was issued.

## Initial TypeScript contract

The repository now defines the platform-neutral contract in `src/core/process-tree-supervisor.ts` and exports its types from `src/core/index.ts`:

- `ProcessTreeSupervisor.launchContainedRunner(options)` launches the trusted bootstrap only. Its promise may resolve only after containment membership and runner readiness are verified.
- `ContainedProcessHandle.send()` and `onMessage()` carry the existing authenticated IPC protocol. Every received message remains untrusted until the per-execution token is checked by the policy runtime.
- `onRunnerExit()` is diagnostic and cannot release execution capacity.
- `terminateTree()` means a termination request was issued; it is not proof of termination.
- `waitForTreeExit()` is the sole completion proof and must resolve only after the complete boundary is verified empty.
- `dispose()` must reject unless successful tree-exit verification has already completed.

The launch options intentionally identify only the trusted runner artifact. The evaluator module is not part of the launch request; it may be named in the authenticated evaluate IPC message only after the supervisor returns a verified handle. The interface has no direct-child fallback.

This is an API contract, not an implementation. It is not yet wired into `ProcessIsolatedPolicyEngine`, and it does not enable custom evaluators in `createProductionCoreEngine()`. A concrete Linux adapter still requires a protected cgroup delegation boundary (or a separate trusted broker/identity) and integration tests using the real evaluator credentials. Until that exists, production remains default-deny.

## Platform requirements

### Linux

Preferred production boundary: a dedicated cgroup v2 per execution, created beneath a deployment-provisioned and delegated cgroup subtree.

- The launcher must place the process in the cgroup before evaluator code runs.
- Termination should use the cgroup-wide kill facility where available.
- Completion requires verifying that the cgroup is empty, not just observing the Node child exit.
- Deployment must explicitly provision delegation and permissions. The application must not silently fall back to direct-child killing or a process group.

A process group alone is not an equivalent security boundary: descendants may create a new session or process group.

#### Linux cgroup delegation and privilege boundary

A delegated cgroup subtree is not automatically safe merely because it is a cgroup v2 subtree. The deployment MUST preserve the kernel's delegation-containment rules:

- The per-execution cgroup MUST be below a supervisor-owned boundary cgroup. The evaluator identity MUST NOT have write access to the boundary's parent-level `cgroup.procs` file or any common-ancestor `cgroup.procs` file that would permit migration out of the boundary.
- The trusted supervisor (or a narrowly scoped privileged broker) is responsible for creating the per-execution cgroup and placing the trusted runner into it before sending the authenticated evaluate message.
- The evaluator MUST NOT receive write access to the supervisor's boundary directory, the boundary's `cgroup.procs`, or the boundary's `cgroup.kill`. In particular, do not expose a writable `cgroup.kill` file descriptor or broker operation to evaluator-controlled code.
- If evaluator and supervisor share a UID, filesystem ownership and mode checks MUST demonstrate that evaluator code cannot modify or remove the supervisor-owned boundary or write to the boundary's parent-level migration control. If this cannot be established, use a separate evaluator identity or a trusted broker; otherwise refuse launch.
- The supervisor MUST terminate and verify emptiness at the supervisor-owned boundary, not at a leaf cgroup that evaluator code can reorganize internally. Moving processes among descendants inside the boundary must not let them escape the boundary-wide kill and emptiness check.
- Deployment validation MUST test attempted migration out of the boundary and attempted modification of supervisor-owned control files using the actual evaluator credentials. Static path checks alone are insufficient.

The kernel documentation describes the common-ancestor permission rule that prevents a delegatee from moving processes across the delegated subtree boundary. This guarantee depends on the relevant permissions remaining outside the delegatee's control. See the Linux kernel cgroup v2 delegation and delegation-containment documentation.


### Windows

Preferred production boundary: a Windows Job Object configured with kill-on-job-close semantics.

- A native launcher or equivalent trusted component must create the process suspended, assign it to the Job Object, configure required limits, and only then resume it.
- The evaluator must not run before assignment succeeds.
- Termination and completion must be based on Job Object membership/accounting, not only the direct child's exit event.
- If the required native facility is unavailable, production launch must fail closed rather than downgrade to `child.kill()`.

### macOS and other platforms

No equivalent strict adapter is currently specified for this repository. Do not claim whole-tree containment on these platforms based on process groups or direct-child signals.

Until a separately reviewed platform boundary is available, deployments that require hostile-evaluator containment must disable that execution mode on unsupported platforms or run it inside an externally managed container/VM boundary with independently verified lifecycle control.

## Lifecycle and capacity semantics

- A timeout or cancellation freezes the policy decision immediately, then asks the supervisor to terminate the entire execution boundary.
- The execution remains `UNRESOLVED` and continues occupying its concurrency slot until `waitForTreeExit` confirms that the boundary is empty.
- A direct-child `exit` or `close` event is diagnostic only; it must not release capacity by itself.
- Supervisor errors, lost control channels, or inability to verify emptiness retain the unresolved slot and fail closed.
- Runtime shutdown must report unresolved containment rather than claim successful cleanup.
- No administrative API may manually clear an unresolved slot without independently verified OS-level termination evidence.

## Required verification before production use

1. Unit tests for launch ordering: evaluator module import cannot occur before containment confirmation.
2. Failure-injection tests for boundary creation, assignment, termination request, control-channel loss, and verification failure.
3. Linux integration test: evaluator starts a harmless descendant fixture; cancellation terminates the complete cgroup and verifies it is empty even when the direct runner exits first.
4. Windows integration test: equivalent descendant fixture under a Job Object; verify kill-on-job-close and empty job accounting.
5. Unsupported-platform test: strict mode refuses to launch rather than silently using direct-child termination.
6. Capacity test: unresolved boundary retains its slot until verified empty; only then can a replacement execution start.
7. CI must report platform integration tests separately from mocked adapter tests. A green mocked test suite is not evidence that OS containment works.

## Explicit non-goals

Process-tree supervision is not a complete sandbox. It does not, by itself, isolate filesystem access, network access, credentials, kernel attack surface, or resource consumption outside the configured boundary. Production deployments must separately define identity, filesystem, network, memory/CPU, syscall, and artifact-integrity controls.

## Current implementation status

The repository currently has no cgroup v2, Windows Job Object, native launcher, or external supervisor integration. The existing process-isolated policy engine remains direct-child isolation only. This specification records the acceptance criteria for a future implementation; it does not close the process-tree containment gap.
