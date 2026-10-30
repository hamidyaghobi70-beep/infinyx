# INFINYX Architecture Overview

## Approved baseline

INFINYX starts as a **Modular Monolith** on Node.js 22+ and TypeScript. Logical modules are not separate deployable services. Microservices, distributed infrastructure, and additional data stores require a documented technical justification and an explicit architecture decision.

## Runtime flow

1. The HTTP entry point receives a request.
2. API middleware applies request parsing and process-local rate limiting.
3. Route handlers call application/module interfaces.
4. Modules communicate through explicit, versionable contracts; cross-module internals are not public APIs.
5. Structured logs support operational diagnosis without recording credentials.

The current implementation exposes only a liveness endpoint. It does not yet implement business workflows, persistence, identity, or agent execution.

## Architectural constraints

- Initial release is single-tenant; avoid assumptions that prevent future tenant isolation.
- Use an internal event abstraction first. Add NATS only when a measured asynchronous requirement justifies it.
- PostgreSQL and Redis are not introduced until concrete persistence/cache requirements exist.
- Agent tool execution stays disabled until a real Tool Gateway with authorization, validation, audit, isolation, and human approval is reviewed.
- Sensitive actions require dry-run and explicit human approval.
- Blockchain intelligence is read-only. No private-key custody, transaction signing, or asset transfer.
- Prefer security, testability, and maintainability over premature infrastructure.

## Evolution

Any change to module ownership, public contracts, persistence, tenancy, or deployment topology must be recorded as an architecture decision before implementation.
