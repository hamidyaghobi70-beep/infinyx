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
