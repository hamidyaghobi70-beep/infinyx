# Process containment spike — Issue #29

Status: **PROTOTYPE / NOT SECURITY-APPROVED**

This spike adds POSIX process-group lifecycle handling to the process-isolated policy evaluator. It is not a sandbox and does not establish complete process-tree containment.

## Current behavior

- On Linux and macOS, the evaluator is started with a dedicated session/process group (`detached: true` in Node's child-process API).
- Cancellation signals the process group, first with `SIGTERM`, then with `SIGKILL`.
- When the direct evaluator closes, the engine checks whether the process group is empty. If members remain, it attempts cleanup and waits for group-empty confirmation.
- A normal allow result is rejected if a same-group descendant was present, even when cleanup later succeeds.
- Capacity remains allocated until the process-group cleanup check completes.
- If group cleanup cannot be confirmed, the result is `UNRESOLVED` and the execution remains fail-closed.
- Windows currently reports `DIRECT_CHILD_ONLY`; this branch does not provide Windows Job Object containment.

## Verified scope and limitation

The fixture suite covers a descendant that survives its direct evaluator parent, ignores `SIGTERM`, and must be killed with `SIGKILL`. It also includes a detached-session escape fixture. A descendant that creates a new session (or otherwise leaves the evaluator's process group) is outside the process group and is not discovered by this mechanism.

Therefore the reported POSIX capability is deliberately `POSIX_PROCESS_GROUP_BEST_EFFORT`, not full process-tree containment. The detached-session test records this limitation explicitly. This mechanism must not be treated as a security boundary against a hostile evaluator capable of creating a new session or using other OS process-escape mechanisms.

## Remaining work before any security approval

1. Review race conditions and PID/process-group lifecycle behavior on Linux and macOS independently.
2. Decide whether evaluator code is trusted not to escape its process group. If it is not trusted, replace this best-effort mechanism with an OS-enforced containment boundary that prevents or detects session escape.
3. Implement and test a Windows native launcher with Job Objects; until then, Windows remains direct-child-only.
4. Verify exact-commit CI on Ubuntu, macOS, and Windows.
5. Obtain independent security review and reproduce all claims from test evidence before changing this status.

No claim of sandboxing, complete process-tree containment, release readiness, or security approval is made by this spike.