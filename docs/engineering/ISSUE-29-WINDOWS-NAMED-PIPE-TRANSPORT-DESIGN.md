# Issue #29 — Windows Named-Pipe Control Transport Design

Status: **DESIGN PROPOSAL — NOT IMPLEMENTED / NOT APPROVED / NOT SECURITY-REVIEWED**

## 1. Decision trigger

The native launcher POC compiles and successfully starts the evaluator Node process inside the creation-time Job Object path. However, passing the parent's Node IPC handle through the C launcher is not a functioning transport: the evaluator reports `process.connected === true`, but its first `process.send()` fails with `EPIPE`; the parent receives no message.

Do not integrate the raw inherited Node IPC handle. Do not parse Node's private IPC framing. Do not move control messages onto stdout/stderr.

This proposal replaces Node's private child-process IPC with an explicit, bounded control protocol over two local Windows named-pipe connections. The native launcher acts only as a byte-stream relay and retains Job Object ownership.

## 2. Proposed topology

1. The Node parent generates a cryptographically random execution identifier, two unpredictable pipe names, and a per-execution nonce.
2. The Node parent starts the native launcher with ordinary stdin/stdout/stderr only; it does not request a Node IPC channel.
3. The launcher creates two separate local duplex named-pipe server instances:
   - parent control endpoint;
   - evaluator control endpoint.
4. Each pipe is created with an explicit DACL granting access only to the current service/user SID and SYSTEM, plus `PIPE_REJECT_REMOTE_CLIENTS` and first-instance protection. The pipe names are unique per execution; pipe names are locators, not authorization.
5. The launcher creates/configures the Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, then creates the evaluator Node process suspended and associates it at process creation with `PROC_THREAD_ATTRIBUTE_JOB_LIST`.
6. The evaluator receives only its pipe name and execution nonce through a minimal, explicitly constructed environment. The evaluator connects to its endpoint. The parent connects to the parent endpoint.
7. The launcher verifies peer process IDs using `GetNamedPipeClientProcessId`: the parent endpoint must be connected by the expected parent PID; the evaluator endpoint must be connected by the exact evaluator PID returned by `CreateProcessW`.
8. After both peers are validated, the launcher relays bytes bidirectionally between the two pipe handles using fixed-size buffers and bounded backpressure. It does not parse or reinterpret protocol frames.
9. If either side disconnects, the launcher closes the opposite side, terminates the Job if necessary, and waits for the Job to become empty before reporting cleanup completion. A relay/pipe failure can never yield an allow result.

The parent and evaluator use Node's supported `net` API to connect to named-pipe paths. No private Node IPC handle, descriptor, or framing is passed through the native launcher.

## 3. Explicit control protocol

Use a versioned, length-prefixed JSON protocol:

- Four-byte unsigned big-endian frame length.
- UTF-8 JSON object body.
- Provisional maximum frame size: **512 KiB**, to be reconciled against the existing 256 KiB policy-input snapshot bound plus serialization overhead.
- Reject zero-length, oversized, truncated, malformed UTF-8, malformed JSON, arrays, unknown message types, unknown protocol versions, wrong execution IDs, and wrong nonces.
- Validate every message against an explicit allow-list schema; never trust arbitrary object properties or coerce types.
- Enforce one `evaluate` per execution; `cancel` is idempotent; `finalize` is accepted only after a terminal result/cancellation state; duplicate or out-of-order terminal messages fail closed.
- Use socket backpressure and fixed maximum pending-write budgets; do not buffer unbounded frames.
- Keep policy data, stdout, and stderr on separate channels. The existing stdout/stderr byte budgets remain independently enforced by the parent.

Message mapping:

| Direction | Message types |
|---|---|
| Parent → evaluator | `evaluate`, `cancel`, `finalize` |
| Evaluator → parent | `started`, `result`, `error`, `cancelled` |

The parent remains the authority for timeout, cancellation arbitration, candidate freeze, terminal veto, and terminal commitment. The evaluator's message is only a candidate; it is not authorization by itself.

## 4. Identity, ACL, and handle rules

- Build the pipe DACL from the current process token SID and SYSTEM; never use `Everyone`, `Authenticated Users`, or remote access.
- Use `PIPE_REJECT_REMOTE_CLIENTS`; named pipes are local-only.
- Verify peer PIDs after connection and before relaying any application bytes.
- Bind both endpoints to the same execution ID and random nonce; compare in constant time where applicable.
- Pipe names and nonce must not be logged. Avoid placing the nonce in command-line arguments; pass it only through a tightly controlled child environment or a dedicated inherited, non-public bootstrap channel.
- Do not inherit the Job handle into the evaluator or descendants.
- Do not enable Job breakaway flags or `CREATE_BREAKAWAY_FROM_JOB`.
- The launcher must not accept a second client on either endpoint.
- If ACL construction, pipe creation, peer PID verification, handshake, relay, or cleanup fails, terminate the Job and deny.

## 5. Launcher relay requirements

The relay is a byte-stream bridge, not a protocol parser. It must:

- use fixed-size buffers and bounded in-flight writes in both directions;
- handle partial reads/writes, fragmentation, coalesced frames, and backpressure;
- handle one-sided disconnect without leaving the other side blocked indefinitely;
- cancel outstanding I/O and close both endpoints deterministically;
- never claim cleanup until the Job active-process count reaches zero;
- terminate remaining Job members when the parent disappears, the evaluator disconnects unexpectedly, or relay I/O fails;
- preserve independent stdout/stderr handles and existing output accounting in the Node parent.

The implementation must select and document a concrete Windows I/O model (overlapped I/O/IOCP or a reviewed bounded worker-thread design). Do not mix synchronous and overlapped pipe operations on the same handle without an explicit contract.

## 6. Required proof and tests before engine integration

1. Named-pipe ACL tests: current user/SYSTEM allowed; unrelated local user denied; remote client denied; first-instance collision fails closed.
2. Peer identity tests: correct parent/evaluator PIDs accepted; wrong PID rejected before application data is relayed.
3. Handshake tests: wrong nonce, wrong execution ID, replay, and duplicate connection rejected.
4. Protocol tests: both directions, all current message types, partial frames, multiple frames per read, malformed JSON/UTF-8, oversized lengths, unknown versions/types, and truncated frames.
5. Backpressure tests: bounded memory under slow/non-reading peer and large allowed policy input.
6. Lifecycle tests: parent crash, evaluator crash, launcher crash, cancellation, timeout, finalize, and disconnect during each protocol state.
7. Job tests: evaluator + grandchild termination, Job active-process count reaches zero, no capacity release while unresolved, no authorization after any relay/cleanup failure.
8. stdio tests: stdout/stderr remain separate and existing per-stream/aggregate output limits still apply.
9. Windows CI compiles the launcher with MSVC and runs all native and Node integration tests on the exact PR head.
10. Independent security review of DACL construction, PID verification, nonce handling, framing/parser, relay concurrency, handle ownership, Job lifecycle, and all claims.

## 7. Residual limitations

Job Objects are process-lifecycle containment for supported Windows process-creation paths, not a complete sandbox. They do not isolate filesystem, network, credentials, kernel attack surface, or all brokered process-creation paths. The interrupted-`CreateProcessW` crash window remains a documented residual risk until authoritative contract analysis and fault-injection evidence close it.

## 8. Implementation boundary

This document is a design proposal only. Do not implement the named-pipe transport or connect it to `ProcessIsolatedPolicyEngine` until the design is accepted. Keep Windows capability as `DIRECT_CHILD_ONLY` until the complete acceptance suite passes and independent security review is complete.
