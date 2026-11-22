# Linux cgroup v2 Broker: Implementation Plan

**Status:** implementation specification; no broker executable, privileged service, or kernel integration is included here. This document is not evidence of containment and must not be used to enable production evaluators.

## Decision and scope

Implement Linux first, behind the existing `LinuxCgroupV2Broker` interface. Keep `createProductionCoreEngine()` default-deny until the broker is deployed and the privileged integration suite passes on the target host. Windows Job Object support remains a separate workstream.

The broker is a small, separately trusted native service. It owns cgroup creation, process launch, process membership, termination, empty-state verification, and cleanup. The Node application is an unprivileged client. Evaluator code must never receive the broker socket, broker credentials, or a handle capable of modifying the supervisor-owned cgroup boundary.

## Trust and deployment model

1. A deployment administrator provisions a cgroup v2 subtree delegated exclusively to the broker service. The service runs under a dedicated OS identity with only the privileges required to manage that subtree.
2. The application connects through a Unix-domain socket whose directory and socket permissions admit only the configured application identity. The broker independently authenticates each connection using kernel peer credentials (for example, `SO_PEERCRED`); it does not trust a UID/PID supplied in a request.
3. The evaluator runs under a distinct, unprivileged identity where practical. It has no write permission on the broker socket, supervisor-owned cgroup directories, parent-level `cgroup.procs`, or boundary `cgroup.kill`.
4. The broker validates the connecting peer identity against deployment policy. It accepts only the trusted runner artifact configured by the administrator; clients cannot supply an arbitrary executable, dynamic library, command line, environment, working directory, or cgroup path.
5. The broker uses a fixed, administrator-owned runner path and a narrow environment allowlist. It must not inherit secrets from the broker service environment or pass application credentials to the evaluator.

If the host cannot establish and verify these identity and permission boundaries, broker startup or launch must fail closed.

## Launch handshake: no evaluator-before-containment race

The broker must not start evaluator code and then move the process into a cgroup. The launch transaction is:

1. Validate peer credentials, protocol version, request size, configured runner identity, and available resource limits.
2. Allocate an opaque random containment ID and create a broker-owned per-execution cgroup beneath the delegated root.
3. Spawn only the trusted bootstrap in a gated state. The bootstrap must not import the evaluator module or process an evaluate message while gated.
4. Place the bootstrap PID in the per-execution cgroup using the broker's privileged authority.
5. Independently read back membership and verify the PID is in the expected cgroup. Verify the evaluator identity cannot write migration controls or supervisor-owned boundary files.
6. Establish the broker-owned IPC relay and confirm the bootstrap is ready but evaluator code remains unloaded.
7. Return a launch attestation only after all checks succeed: protocol version, opaque containment ID, containment established, evaluator not loaded.
8. The application may now send the authenticated evaluate message over the relay. Only then may the trusted bootstrap import the configured evaluator module.

Any failure before attestation aborts launch. The broker retains ownership of partially allocated resources, requests boundary termination, verifies emptiness, and releases only after proof. If cleanup cannot be proven, it retains an operator-recoverable allocation and reports the failure; it must never silently orphan or forget it.

## Version 1 control protocol

Use a length-delimited, bounded message format over the Unix socket. Reject oversized frames, unknown message types, duplicate request IDs, malformed fields, and unsupported protocol versions. Every request and response is correlated by an unpredictable request ID. The broker must not interpret evaluator-originated payloads as broker commands.

Required operations:

| Operation | Request purpose | Success condition |
|---|---|---|
| `LAUNCH_TRUSTED_RUNNER` | Create cgroup, gated bootstrap, relay | Attestation returned only after verified membership and runner readiness |
| `RUNNER_SEND` | Relay an application-to-runner message | Message accepted by the live runner channel; not an execution-success claim |
| `RUNNER_EVENT` | Deliver runner messages/errors/exit diagnostics | Event tagged with containment ID and channel sequence |
| `TERMINATE_BOUNDARY` | Request boundary-wide termination | Request accepted; explicitly not an emptiness proof |
| `WAIT_BOUNDARY_EMPTY` | Observe the complete broker-owned boundary | Resolves only after independent empty-state verification |
| `RELEASE_BOUNDARY` | Remove per-execution resources | Accepted only after successful empty verification |
| `QUERY_STATUS` | Recover status after client reconnect | Reports broker-owned state; never clears or releases it |

The broker must bind each operation to the authenticated connection and containment ID. A client must not operate on another client's boundary. IDs are opaque correlation values, not paths or authorization secrets.

## cgroup lifecycle and proof requirements

- The broker owns the boundary cgroup and all relevant control files. Evaluator code cannot write the boundary's `cgroup.procs` or `cgroup.kill`, nor move processes to an ancestor outside the boundary.
- Termination uses the boundary-wide cgroup v2 kill facility where supported. Do not substitute direct-child signals or process-group signaling.
- Empty verification must use kernel-observed state for the broker-owned boundary (including `cgroup.events` populated state) and account for all descendants within that boundary. A runner exit event is diagnostic only.
- Verification must be retried safely when the kernel reports the boundary is still populated. A transient read error is not proof of emptiness.
- The broker serializes termination, empty verification, and release. A successful empty proof prevents a later operation from resurrecting the execution; a failed proof leaves the boundary owned and recoverable.
- Release is idempotent only after verified emptiness. It must never be used as a cleanup shortcut after a timeout.
- On broker crash/restart, startup reconciliation enumerates broker-owned allocations beneath its delegated root. It must retain and recover or terminate each allocation and verify emptiness before removing it. It must not assume that a lost in-memory map means the cgroup is gone.
- The broker persists enough minimal ownership metadata to reconcile allocations after restart. Metadata must not contain evaluator secrets or policy request contents.

## Resource and abuse controls

The broker enforces administrator-configured limits independently of client input: maximum concurrent boundaries, memory ceiling, process count, CPU policy where available, wall-clock ceiling, maximum message size, and maximum lifetime for idle allocations. Requests exceeding policy are rejected before launch. Resource-control setup must be verified by reading back the configured kernel controls; unsupported controls cause launch refusal rather than silent downgrade.

This is process-tree supervision, not a complete sandbox. Filesystem access, network egress, credentials, syscall exposure, and artifact integrity require separate controls and review.

## Node adapter integration sequence

After the broker executable and protocol tests exist:

1. Implement a Node Unix-socket client that authenticates the server endpoint and validates protocol version and every response.
2. Implement `LinuxCgroupV2Broker.launchTrustedRunner()` using only the fixed trusted runner configuration; do not accept caller-selected executable paths from evaluator requests.
3. Implement the returned handle's `send`, `onMessage`, `onError`, `onRunnerExit`, `terminateBoundary`, `waitForBoundaryEmpty`, and `releaseBoundary` as correlated broker operations.
4. Inject `ProcessTreeSupervisor` into `ProcessIsolatedPolicyEngine`. Replace direct `fork()`, `child.kill()`, and direct-child `close` as the capacity-release proof with the supervisor lifecycle. Preserve the existing per-execution response token and validate every runner message in the parent.
5. On cancellation or timeout, freeze the deny decision, request boundary termination, await verified emptiness, then dispose. If any broker operation fails or the control channel is lost, return/retain `UNRESOLVED` and keep the capacity slot occupied.
6. Keep the production factory default-deny until all integration gates below pass.

Do not wire the current adapter into the engine before the broker and lifecycle implementation are complete. A half-integrated adapter would create ambiguous ownership and cleanup behavior.

## Required integration evidence

Run these tests on a disposable Linux CI runner with cgroup v2 enabled and the actual deployed application/evaluator identities:

- **Pre-import gate:** instrument the evaluator fixture and prove it cannot import or execute before the broker attestation and explicit evaluate message.
- **Descendant cleanup:** start a harmless fixture descendant, make the direct runner exit first, request cancellation, and prove the complete boundary becomes empty.
- **Escape resistance:** as the evaluator identity, attempt migration to an ancestor and writes to supervisor-owned control files; all attempts must be denied.
- **Boundary isolation:** prove one execution cannot send, terminate, inspect, or release another execution's boundary.
- **Failure injection:** fail cgroup creation, process assignment, relay setup, termination, empty-state reads, release, and broker restart recovery. No failure may free capacity without empty proof.
- **Concurrency and resource limits:** exceed each configured limit and verify deterministic fail-closed rejection.
- **Control-channel loss:** disconnect the application while work is active; broker ownership and cleanup/recovery continue independently.
- **Negative platform test:** when cgroup v2, required controllers, permissions, or kernel facilities are unavailable, launch is refused. No direct-child or process-group fallback is permitted.

CI must report these privileged Linux integration tests separately from mocked TypeScript adapter tests. A green unit-test matrix is not a substitute for this evidence.

## Acceptance gate

The Linux implementation is not complete until the native broker, service deployment, Node transport, engine integration, crash recovery, and privileged integration suite are all reviewed together. The PR must remain Draft and production custom evaluators must remain disabled until then. This plan does not authorize merge, release, deployment, or production activation.

## CI environment finding (2026-11-22)

A read-only inspection on GitHub-hosted `ubuntu-latest` (workflow run `44971572408`, Ubuntu job `137052307606`) observed:

- Linux kernel `7.0.0-1016-aws x86_64`; cgroup v2 controller file present.
- Controllers listed: `cpuset`, `cpu`, `io`, `memory`, `hugetlb`, `pids`, `rdma`, `misc`, `dmem`.
- The runner process was in `/system.slice/hosted-compute-agent.service`.
- The cgroup root path was not writable by the runner; root `cgroup.events` was absent or unreadable.

**Conclusion:** this hosted runner is not a provisioned delegated cgroup environment and cannot serve as the privileged Linux containment integration runner. The presence of cgroup v2 and controllers is insufficient. Do not attempt to gain broader host privileges from an ordinary hosted workflow.

The next infrastructure prerequisite is a disposable, administrator-managed Linux integration runner whose operator explicitly provisions a broker-owned delegated subtree and distinct application/evaluator identities. Before any broker implementation is considered deployable, that runner must independently demonstrate the exact delegation, ownership, and permission boundary required above. The ordinary cross-platform CI matrix remains useful for build and mocked tests, but must not be labelled as OS-containment evidence.

This inspection was read-only: no cgroups were created or modified, and no broker was installed or activated.
