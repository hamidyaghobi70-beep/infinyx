# Issue #29 — Windows Named-Pipe Control Transport Design

Status: **DESIGN PROPOSAL — NOT IMPLEMENTED / NOT SECURITY-APPROVED**

## Decision

The raw inherited Node IPC endpoint experiment is a negative result. The evaluator reports `process.connected === true`, but its first `process.send()` fails with `EPIPE`. Do not pass Node's private IPC handle through the native launcher, parse Node's private IPC framing, or use stdout/stderr as a control channel.

The next experiment is a separate, explicit local named-pipe transport. It is not a production-engine change.

## Proposed topology

- The Node parent creates a cryptographically random execution ID, two unpredictable local pipe names, and a per-execution nonce.
- The parent starts the native launcher with ordinary stdio only; no Node IPC channel is requested.
- The launcher creates two separate local named-pipe endpoints: parent-to-launcher and launcher-to-evaluator.
- Each pipe uses an explicit DACL for the current service/user SID and SYSTEM, `PIPE_REJECT_REMOTE_CLIENTS`, and first-instance semantics. Pipe names are locators, never authorization.
- The launcher creates an unnamed Job Object configured with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, then creates the evaluator suspended and associates it with the Job at process creation using `PROC_THREAD_ATTRIBUTE_JOB_LIST`.
- The evaluator connects to its endpoint using Node's supported `net` API. The parent connects to its endpoint using the same API.
- The launcher verifies connecting peer PIDs with `GetNamedPipeClientProcessId` against the expected parent and exact evaluator PIDs before relaying application bytes.
- The launcher relays bounded byte streams in both directions. It does not parse application protocol frames.
- Any pipe, identity, handshake, relay, process, or cleanup error terminates the Job and fails closed. No direct-child fallback is permitted.

## Versioned control protocol

Use a four-byte unsigned big-endian length followed by UTF-8 JSON. Provisional maximum frame size: 512 KiB; reconcile with the existing policy-input snapshot and output limits before implementation.

Reject zero-length, oversized, truncated, malformed UTF-8/JSON, arrays, unknown versions/types, mismatched execution IDs/nonces, duplicate terminal events, and out-of-order state transitions. Validate each message against explicit schemas. Use bounded writes/backpressure; never buffer unbounded peer input.

Parent-to-evaluator messages: `evaluate`, `cancel`, `finalize`.

Evaluator-to-parent messages: `started`, `result`, `error`, `cancelled`.

The parent remains authoritative for timeout, cancellation arbitration, candidate freeze, terminal veto, and terminal commitment. An evaluator message is only a candidate, never authorization by itself.

## Identity and handle rules

- Build the pipe DACL from the current process token SID and SYSTEM. Never grant Everyone or Authenticated Users.
- Reject remote clients and accept only one client per endpoint.
- Verify peer PID before accepting application bytes.
- Bind both endpoints to the same execution ID and nonce; never log pipe names or nonce.
- Do not inherit the Job handle into the evaluator.
- Do not set Job breakaway flags or `CREATE_BREAKAWAY_FROM_JOB`.
- If ACL, pipe creation, peer verification, handshake, relay, or cleanup fails, terminate the Job and deny.

## Required acceptance tests before engine integration

1. ACL: current user and SYSTEM accepted; unrelated local user and remote client rejected; first-instance collision fails closed.
2. Peer identity: expected parent/evaluator PIDs accepted; wrong PID rejected before relaying data.
3. Handshake: wrong nonce/execution ID, replay, and duplicate connections rejected.
4. Framing: both directions, fragmentation, coalesced frames, malformed UTF-8/JSON, oversized/truncated frames, unknown versions/types.
5. Backpressure: bounded memory with a slow/non-reading peer and maximum permitted payload.
6. Lifecycle: parent/evaluator/launcher crash, cancellation, timeout, finalize, disconnect at each protocol state.
7. Job: evaluator and grandchild termination; Job active-process count reaches zero; capacity is not released while cleanup is unresolved; no allow after relay/cleanup failure.
8. Stdio: stdout/stderr remain separate and existing output limits remain enforced.
9. Exact-head Windows CI builds native code and runs all native and Node integration tests.
10. Independent security review of DACLs, PID checks, nonce handling, parser, relay concurrency, handle ownership, Job lifecycle, and all security claims.

## Residual limitations

Job Objects provide process-lifecycle controls for supported Windows process-creation paths, not a complete sandbox. They do not isolate filesystem, network, credentials, kernel attack surface, or every brokered process-creation path. The interrupted-`CreateProcessW` crash window remains a documented residual risk until authoritative contract analysis and fault-injection evidence address it.

## Implementation boundary

Implement only a standalone named-pipe proof of concept first. Do not modify `ProcessIsolatedPolicyEngine` or upgrade Windows capability from `DIRECT_CHILD_ONLY` until every acceptance gate passes and an independent security review is complete. No merge, release, deployment, or Agent/Tool activation is authorized by this design.
