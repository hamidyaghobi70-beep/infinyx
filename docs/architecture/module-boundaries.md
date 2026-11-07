# Module Boundaries

The following are logical boundaries within one deployable application. They do not imply microservices or require every directory to exist in the foundation commit.

| Area | Responsibility | Boundary / restriction |
| --- | --- | --- |
| Core Platform | Configuration, lifecycle, shared runtime contracts | No business-domain policy |
| API Gateway | HTTP routing, request validation, transport concerns | No direct access to module internals |
| Agent Runtime | Agent lifecycle and execution context | Execution remains disabled until safety controls exist |
| Agent Orchestrator | Planning and coordination contracts | Cannot bypass policy or approvals |
| Memory Layer | Future memory interfaces and retention policy | No persistence until privacy and retention are designed |
| Tool Gateway | Future mediated tool access | Default-deny; not implemented/enabled in this foundation |
| Automation Engine | Future scheduled/event-triggered workflows | Sensitive actions require approval |
| Blockchain Intelligence | Future chain data ingestion/analysis | Read-only in v1; no signing or custody |
| Observability | Logs, metrics, traces and health semantics | Never expose secrets or sensitive payloads |
| Security Layer | Authentication, authorization, policy and audit contracts | Identity/provider decision remains open |

## Dependency rules

- Depend on contracts, not another module's private implementation.
- Keep transport-specific types at the API boundary.
- Validate untrusted input at boundaries.
- Avoid circular module dependencies.
- Shared code is for genuinely cross-cutting primitives, not a shortcut around ownership.
- Introduce versioned contracts when compatibility across independently evolving components becomes necessary.

## Foundation scope

This commit implements only configuration, structured logging, an HTTP health endpoint, process-local rate limiting, error handling, and a small API test. Authentication/authorization and domain modules are explicitly deferred rather than represented by insecure placeholders.
