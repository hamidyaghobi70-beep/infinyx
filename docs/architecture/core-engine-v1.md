# Core Engine v1

## Purpose

Core Engine v1 provides the in-process lifecycle and coordination foundation for the INFINYX modular monolith. It is a library inside the existing Node.js application, not a separate service or a business-domain engine.

## Included capabilities

- Explicit lifecycle: created, initializing, initialized, starting, running, stopping, stopped and failed.
- Module registration with stable identifiers, versions and declared dependencies.
- Deterministic dependency ordering; missing dependencies and cycles fail closed.
- Initialization and startup hooks with reverse-order cleanup on failure.
- An in-memory asynchronous event bus. Publishing waits for subscribed handlers; handler failures are reported as an AggregateError.
- A policy port with a default-deny implementation.
- An optional memory port contract. No persistence adapter or storage is included.

## Module contract

A module declares an identifier, version, optional dependencies, and optional initialize/start/stop hooks. A module receives only its own ModuleContext. Modules should depend on public contracts rather than importing another module's private implementation.

Registration is closed after initialization begins. Modules are initialized and started in dependency order and stopped in reverse order. The stop hook is also called for a module whose initialization failed, so it must safely handle partially initialized resources.

## Security boundaries and non-goals

- Default policy evaluation denies every request. This is not authentication, identity management or a complete authorization system.
- The policy engine must be explicitly replaced with a reviewed implementation before protected operations are enabled.
- The memory port is an interface only. No data is persisted by Core Engine v1. Encryption, retention, tenant isolation, access control and deletion guarantees remain design requirements for any adapter.
- The event bus is process-local, non-durable, and has no retry, replay, dead-letter or cross-process delivery guarantees.
- No agent execution, tool execution, automation, external network access or financial action is enabled.
- No wallet key custody, transaction signing or asset transfer is implemented.
- The engine does not create an HTTP endpoint or bypass the API boundary.

## Operational constraints

Core Engine is single-process and single-tenant in this phase. Interfaces should not encode assumptions that prevent later tenant isolation, but no multi-tenant security claim is made.

Before production use, add independent review of lifecycle failure modes, authorization policy, memory adapter threat model, event delivery semantics, observability and operational shutdown behavior.

## Runtime compatibility

The repository minimum runtime is Node.js `22.12.0`, matching the minimum Node 22 engine requirement declared by Vitest 5.0.5 and Vite 7.3.7. CI currently validates on Node.js `22.23.4`.


## Process shutdown (Revision v4)

The HTTP composition root uses a single shutdown controller. SIGINT, SIGTERM, uncaughtException and unhandledRejection all converge on the same shutdown Promise; no handler calls the exit function independently. Fatal events set the final exit code to 1 even when a signal-initiated shutdown is already in progress. The exit function is guarded by a shared exit Promise and is invoked at most once.

Process handlers are installed before Core Engine startup. Shutdown waits for an in-flight startup hook, prevents the HTTP listener from starting after an early signal, drains the HTTP server, then stops Core Engine. The HTTP drain timeout defaults to 10 seconds; if it expires, remaining HTTP connections are closed and the final exit code becomes 1. HTTP close errors and Core Engine stop errors also produce a non-zero exit code.

The runtime accepts an injected exit function. Tests provide a spy rather than process.exit, so exercising signal and fatal-event handlers never terminates the Vitest process. The integration tests measure both the Core Engine stop call count and final exit call count.

## Protected operation admission and drain (Revision v6)

Core Engine wraps every service port exposed through its public surface and ModuleContext: EventBusPort, PolicyEngine and the optional injected MemoryPort. The optional memory port remains an external interface; Core Engine v1 supplies no persistence adapter. The raw injected ports are not exposed through ModuleContext.

Every module initialize/start hook runs inside a tracked operation context. Service calls made by that hook, event handlers, and nested service calls inherit a parent operation through AsyncLocalStorage. Once admission closes, independent operations are rejected, while a child may register only while its parent handle remains in the active registry. Detached callbacks that run after parent settlement are rejected.

The registry tracks per-handle pendingPromiseCount separately from the global activePromiseCount and activeHandleCount. Registry transitions are synchronous and contain no await point, providing a single linearization point in the Node.js event loop for parent settlement versus child registration. A handle is removed only when its own pending promise count reaches zero; releasing an IDLE handle removes it immediately, and tracking after manual release is rejected.

Shutdown first closes independent admission and drains all accepted operations. Module stop hooks then run as privileged tracked cleanup roots; any service operations they start are tracked as children, followed by a second drain before the engine reports STOPPED. A drain timeout leaves the engine in FAILED with failureReason=drain_timeout and does not discard live handles or begin unsafe cleanup. After the outstanding work settles, a later stop call may safely retry. Cleanup failures are reported separately as failureReason=cleanup_error and only failed resources are retried. This retry guarantee applies only while the same Node.js process remains alive and the caller invokes stop again after the outstanding work settles. The production ServerRuntime deliberately treats a Core Engine stop failure (including drain_timeout) as an unsuccessful shutdown: it records exit code 1 and invokes its configured exit function. With the production exit function wired to process.exit, the process terminates and in-memory handles/registry state are lost; recovery therefore requires a process restart, not an in-process retry. This is an explicit bounded-shutdown fail-safe policy, not a claim that the production runtime retries after timeout. The OS child-process integration test verifies this behavior with an accepted operation that remains pending through SIGTERM.
