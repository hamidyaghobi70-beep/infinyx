# Lifecycle Shutdown Test Matrix

## Cleanup retry contract

Core Engine cleanup hooks use an **explicit retry** policy. Each module has at
most one in-flight cleanup attempt at a time. When a hook succeeds, that module
is removed from the pending cleanup queue and will not be cleaned again during
the same lifecycle. When a hook fails, it remains pending and its state becomes
`failed`; a later, explicit `stop()` call retries only the failed/pending
module hooks. Successful sibling hooks are not repeated.

Core Engine does not retry a failed hook automatically inside the same
Shutdown attempt. The caller must explicitly call `stop()` again after
handling or deciding to retry the failure. Module cleanup hooks should be
idempotent or otherwise safe to retry because a failure can occur after partial
external side effects. Every failed attempt is reported to its caller.

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
