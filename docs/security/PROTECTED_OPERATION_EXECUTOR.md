# Protected Operation Executor (GAP-002)

**Status:** Infrastructure implementation; authentication integration is not provided.

## Execution boundary

- The application composition root registers each protected operation on `CoreEngine` before initialization.
- Each registration fixes the operation ID, policy action, policy resource, input validator, and handler in Core-owned state.
- `ModuleContext` exposes only `protectedOperations.execute(...)`; it does not expose the PolicyEngine, registration, handler map, or a reusable authorization grant.
- The operation handle is an opaque object reference checked against a per-executor `WeakMap`; a forged handle or a handle from another executor is denied.
- The policy request's action and resource come from the registration, not caller-controlled fields. The caller can supply only actor/context data.
- Caller context is copied into a detached snapshot before asynchronous policy evaluation. Cyclic, accessor-bearing, symbol-keyed, exotic, or otherwise non-cloneable values fail closed. The resulting snapshot is deeply frozen so caller mutation cannot change the evaluator's view.
- The Core-owned lifecycle gate admits execution only while CoreEngine is `running`. It is checked on entry, immediately before Policy evaluation, and immediately before handler admission. Once `stopping` begins, new work and policy evaluations that have not yet admitted a handler are denied. A handler already admitted before the stop transition is in-flight; this executor does not forcibly interrupt it, and its handler must honor the supplied AbortSignal if cooperative cancellation is required.
- Only a structurally valid `{ effect: "allow", reason: non-empty string }` decision reaches the handler. Deny, cancellation, timeout, malformed decisions, invalid inputs, and policy exceptions fail closed.
- Authorization is consumed inside the same `execute` call. No grant/token is returned, cached, or transferable.

## Duplicate-request and replay limitations

The `usedRequests` guard is a `WeakMap<operationHandle, WeakSet<callerObject>>`. It suppresses reuse of the **same JavaScript caller object identity** for the same in-memory operation handle, including concurrent calls in this process. A newly-created object with identical fields has a different identity and is not detected as a duplicate by this mechanism.

Because WeakMap/WeakSet state is process-local, non-enumerable, non-persistent, and lost on process restart, this is **not durable replay protection**. It does **not** provide exactly-once execution, cross-process deduplication, idempotency, or crash-safe replay prevention. Those require a separately designed persistent idempotency/replay store and transactional side-effect contract; none is implemented here.

## Identity and trust limitations

There is no authenticated identity provider or verified principal contract in this repository stage. `actorId` remains caller-supplied input and MUST NOT be treated as proof of identity. This executor establishes an authorization execution boundary only; it does not authenticate callers, issue credentials, or simulate authentication. Until a trusted identity adapter is approved and integrated, production-sensitive operations must remain disabled or use a separately verified trusted caller path.

## Core / Security / Domain responsibilities

- **Core:** owns the executor, lifecycle admission, opaque operation handles, validation ordering, cancellation propagation, and fail-closed decision enforcement.
- **Security:** supplies the trusted policy implementation and, in a later separately approved stage, authenticated principal/context integration.
- **Domain modules:** receive only the execute-only port and opaque operation handles explicitly passed by the composition root; they do not receive registered handler references, registration methods, or direct PolicyEngine access.

This is an in-process TypeScript boundary, not a hostile-code sandbox. Code that can execute arbitrary JavaScript in the same process can bypass any library-level convention by performing its own side effects. Stronger enforcement requires repository architecture rules and/or process isolation; this stage does not claim to sandbox untrusted modules.

## Explicit exclusions

No credentials, authentication provider, signing, wallet access, external tool execution, deployment, or shutdown-timeout contract changes are introduced. Shutdown Timeout Contract v6.2 remains on HOLD.
