# Lifecycle Shutdown Test Matrix

## Cleanup retry contract

Core Engine cleanup hooks use an **at-most-once** invocation policy per module
lifecycle. A hook is marked attempted before user code is invoked. If it fails,
the failure is retained and re-reported by subsequent `stop()` calls; the
hook is not silently retried. The module remains in the `failed` state and is
removed from the pending cleanup queue.

This policy avoids repeating partially completed external side effects. It does
not guarantee that a failed cleanup completed successfully. Recovery must be
explicitly designed by the owning module/operator (for example, an idempotent
reconciliation operation); calling `stop()` again is not a retry mechanism.

## AsyncLocalStorage boundary

A cleanup hook receives a context object whose `active` flag is true only
while that hook is executing. Async resources created by the hook inherit the
same object. When the hook settles, the object is deactivated in `finally`.
A `stop()` call in an active context for the same engine is rejected as
re-entrant; a detached timer that runs after its originating hook settles can
join the already-running shared shutdown promise.

The timer distinction is temporal and explicit: a timer callback that fires
before its originating hook settles is still active re-entry; a callback that
fires after that hook settles is detached from the active cleanup phase.

## Platform matrix

| Runner | Real SIGINT/SIGTERM tests | IPC graceful-shutdown test | Expected reporting |
| --- | --- | --- | --- |
| Ubuntu/Linux | Run | Run | POSIX tests must Pass |
| macOS | Run | Run | POSIX tests must Pass |
| Windows | Skip (Not Applicable) | Run | POSIX tests must be reported as Skip, never Pass |

Windows does not provide full POSIX signal semantics. Node.js documents that
signals such as SIGINT and SIGTERM do not behave on Windows as they do on
Unix-like systems; sending several signals may terminate a process rather than
exercise the registered JavaScript signal handlers. Consequently, Windows
must not claim to validate real SIGINT/SIGTERM handler execution. The IPC test
validates the application's graceful-shutdown path on Windows, but is not a
substitute for the POSIX signal tests.

## Required process-test evidence

The Child Process tests coordinate through explicit stdout markers and stdin
commands rather than timing assumptions. The second-signal scenario holds the
first cleanup hook open, sends SIGINT, waits until cleanup has started, sends
SIGTERM, verifies both signal receipts, then releases cleanup. It asserts one
cleanup start, one cleanup completion, and one exit marker.

A successful process exit alone is insufficient evidence of exactly-once
cleanup. Test reports must preserve Pass/Fail/Skip distinctions and include
the child exit code, terminating signal, stdout and stderr on failure.
