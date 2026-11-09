# Protected Operation Executor (GAP-002)

**Status:** Infrastructure implementation; authentication integration is not provided.

## Execution boundary

- The application composition root registers each protected operation on
  `CoreEngine` before initialization.
- Each registration fixes the operation ID, policy action, policy resource,
  input validator, and handler in Core-owned state.
- `ModuleContext` exposes only `protectedOperations.execute(...)`. It does
  not expose registration, the handler map, or a reusable authorization grant.
- The operation handle is an opaque object reference checked against a
  per-executor `WeakMap`; a forged handle or a handle from another executor
  is denied.
- The policy request's action and resource come from the registration, not
  caller-controlled fields. The caller can supply only actor/context data.
- Input validation and policy evaluation happen before the handler call.
  Only a structurally valid `{ effect: "allow", reason: non-empty string }`
  decision reaches the handler. Deny, cancellation, timeout, malformed
  decisions, invalid inputs, and policy exceptions fail closed.
- Authorization is consumed inside the same `execute` call. No grant/token is
  returned, cached, or transferable to another operation. Reusing the same
  caller request object for the same operation is rejected, including
  concurrent duplicate attempts.
- The caller's cancellation signal is propagated through policy evaluation
  and to the handler context. Cancellation after a handler has started is
  cooperative: the handler must observe its signal; JavaScript cannot undo
  side effects that already began.

## Identity and trust limitations

There is no authenticated identity provider or verified principal contract in
this repository stage. `actorId` remains caller-supplied input and MUST NOT be
treated as proof of identity. This executor establishes an authorization
execution boundary only; it does not authenticate callers, issue credentials,
or simulate authentication. Until a trusted identity adapter is approved and
integrated, production-sensitive operations must remain disabled or use a
separately verified trusted caller path.

## Core / Security / Domain responsibilities

- **Core:** owns the executor, opaque operation handles, validation ordering,
  cancellation propagation, and fail-closed decision enforcement.
- **Security:** supplies the trusted policy implementation and, in a later
  separately approved stage, authenticated principal/context integration.
- **Domain modules:** receive only the execute-only port and operation handles;
  they do not receive registered handler references or registration methods.

This is an in-process TypeScript boundary, not a hostile-code sandbox. Code
that can execute arbitrary JavaScript in the same process can bypass any
library-level convention by performing its own side effects. Therefore
operation handlers must be registered by the composition root and must not be
exposed as public module APIs. Stronger enforcement requires repository
architecture rules and/or process isolation; this stage does not claim to
sandbox untrusted modules.

## Explicit exclusions

No credentials, authentication provider, signing, wallet access, external tool
execution, deployment, or shutdown-timeout contract changes are introduced.
Shutdown Timeout Contract v6.2 remains on HOLD.
