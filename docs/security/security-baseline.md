# Security Baseline

## Implemented in this foundation

- Environment configuration is parsed with Zod and bounded port validation.
- The HTTP server binds to loopback by default.
- Express identifies itself without the default `X-Powered-By` header.
- JSON request bodies are limited to 100 KB.
- A process-local rate limiter is applied to HTTP requests.
- Pino redacts common credential-bearing fields from structured logs.
- Unhandled errors return a generic response; internal details are logged server-side.
- Secrets, key files, build output, dependencies, and local environment files are excluded by Git ignore rules.

## Not yet implemented — do not assume protection exists

- Authentication and authorization, including tenant isolation.
- Centralized/distributed rate limiting, abuse detection, and edge/WAF controls.
- Secret manager integration and production secret rotation.
- CSRF policy for any future cookie-authenticated browser flows.
- SSRF-safe outbound networking, URL allowlists, and egress controls.
- Agent/tool authorization, sandboxing, prompt-injection defenses, and human approval workflow.
- Durable audit storage, security monitoring, backup/restore, and incident response.
- Dependency lockfile, automated dependency review, and vulnerability scanning.

## Operational restrictions

Do not expose this starter server to the public internet or use it for sensitive workloads before the missing controls are designed, implemented, and independently reviewed. The in-memory rate limiter is per process and is not a distributed abuse-control system. Do not enable Express proxy trust without a known, correctly configured trusted-proxy topology.

Never store wallet private keys, signing secrets, production credentials, or tokens in source control. Blockchain v1 remains read-only; transaction signing and asset transfer are prohibited.

## Review gate

Before production deployment, require documented threat modeling, authentication/authorization review, security tests, dependency and lockfile review, secret scanning, CI enforcement, and an independent security review.
