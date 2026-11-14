# INFINYX Engineering Design: Descendant Process Containment

**Document ID:** INFINYX-ENG-005  
**Status:** Draft — design decision; implementation not authorized by this document  
**Parent baseline:** `fix/policy-hard-termination-escalation` at `e3092f0857acb1dfe0165e8309c1858245b4b026`  
**Scope:** OS-level cleanup and containment of processes started by the isolated policy evaluator

## 1. Problem statement

INFINYX-ENG-004 escalates termination of the direct evaluator child and releases capacity only after that child's `close` event. It does not guarantee that descendants started by the evaluator have stopped. A descendant may outlive the direct child or inherit stdout/stderr handles, keeping the parent's close barrier open.

The next stage must distinguish three claims:

1. **Direct-child termination:** the evaluator process itself has exited.
2. **Process-tree cleanup:** processes in the evaluator's managed process group/job have been asked to terminate and their termination has been confirmed to the extent supported by the OS mechanism.
3. **Sandboxing:** the evaluator cannot escape its assigned boundary or access unauthorized host resources.

Process-group or Job Object cleanup is not, by itself, a sandbox. No implementation may describe it as one.

## 2. POSIX design candidate (Linux and macOS)

### 2.1 Launch boundary

- Launch the evaluator as a dedicated process group/session using Node's `detached: true` behavior on POSIX.
- Record and validate the spawned process identifier before any group operation.
- Never signal the parent's own process group.
- Send graceful termination to the dedicated group, then forceful termination to that same group after the configured wait.
- Keep stdout/stderr observation and capacity accounting active until the direct child and its stdio close barrier have completed.

### 2.2 Required cautions

- A process group is a cleanup mechanism, not an adversarial security boundary. A descendant may create a new session/process group and escape.
- Group identifiers are numeric and can eventually be reused. Group signaling must be narrowly scoped, bounded in time, and guarded against use before successful spawn. The implementation review must explicitly analyze the interval between direct-child exit, descendant lifetime, and the final group signal.
- A successful signal request is not proof that every descendant has exited.
- If the direct child closes while a descendant remains in the group but does not hold inherited stdio, the parent's `close` event alone cannot prove that the group is empty. A separate OS-level confirmation strategy is required before claiming process-tree cleanup.
- Linux cgroups v2 or an equivalent managed scope is a stronger candidate for enforceable membership and accounting; it is a separate mechanism and must not be conflated with process groups.
- macOS does not provide an equivalent built-in Job Object API through Node's standard `child_process` interface. Any stronger macOS containment mechanism requires a separately reviewed native/platform design.

### 2.3 POSIX acceptance criteria

- A fixture spawns a descendant that ignores graceful termination and remains alive after its parent evaluator exits.
- The test proves the descendant is terminated by the group escalation path, not merely that the direct child closed.
- A fixture attempts to detach into another session; the result documents that process-group containment cannot stop this escape and must not claim sandbox-level protection.
- Tests prove no signal is sent before successful spawn and no signal can target the INFINYX parent process.
- Tests cover direct-child exit before descendant exit, inherited stdio, group-signal errors, and capacity retention when termination cannot be confirmed.

## 3. Windows design candidate

- Node's public `child_process` API does not expose creation, assignment, and lifecycle control for Windows Job Objects.
- `detached: true`, `child.kill()`, or shell-based process-tree commands are not substitutes for Job Object containment.
- A correct Job Object design should use `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, disallow breakaway unless explicitly required, and assign the process before untrusted evaluator code can create descendants.
- Because assignment after ordinary process creation can leave a race in which the child spawns descendants before assignment, a native launcher/helper must create the evaluator suspended, assign it to the Job Object, then resume it. The helper's build, signing/provenance, update, and failure behavior require separate review.
- Do not add an unreviewed native dependency or claim Windows process-tree containment until the helper and its lifecycle are implemented and tested.

## 4. Cross-platform contract

Until each platform has a verified containment mechanism:

- Keep the existing direct-child behavior and its explicit limitation.
- Do not report descendant termination as confirmed based only on the direct child's `close` event.
- Do not release a capacity slot based on a timer or a successful signal request.
- Preserve fail-closed policy outcomes; uncertainty must never become `AUTHORIZED`.
- Record platform capability explicitly in internal diagnostics without exposing OS details or evaluator output to callers.
- Agent/Tool execution remains disabled; this design does not authorize production activation.

A future implementation may expose a capability such as `direct-child`, `best-effort-process-group`, or `job-object-contained`, but the capability must be derived from the mechanism actually active on that host, not from configuration intent.

## 5. Decision and implementation gate

**Decision:** Do not implement a single cross-platform “kill process tree” abstraction using only Node's standard `child_process` API. It would overstate the Windows guarantee and the escape resistance of POSIX process groups.

Implementation is gated on all of the following:

1. A platform-by-platform threat model and lifecycle state machine.
2. A documented decision on whether best-effort POSIX process-group cleanup is acceptable for the first increment, with explicit non-sandbox semantics.
3. A Windows Job Object helper design that closes the pre-assignment race.
4. A proof strategy for descendant completion and capacity release; direct-child `close` is insufficient by itself.
5. Deterministic tests for descendant survival, escalation, escape attempts, and unresolved cleanup.
6. CI evidence on Ubuntu, macOS, and Windows for the exact proposed commit SHA.

## 6. Non-goals

This stage does not implement filesystem/network isolation, credential isolation, syscall filtering, cgroups, containers, Windows Job Objects, macOS sandboxing, or a production security boundary. Those require separate decisions and verification.

## 7. Governance

This is a design-only Draft proposal. It does not authorize merge, release, deployment, changes to `main`, enabling Agent/Tool execution, or adding native dependencies. The existing PR #27 direct-child contract remains the implemented behavior until a separately reviewed implementation is accepted.
