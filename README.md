# INFINYX

**A Universe of Infinite Possibilities**

INFINYX is a Modular Autonomous Intelligence Platform. The approved starting point is a TypeScript/Node.js modular monolith, with explicit module boundaries and security controls.

## Repository status

This branch prepares a restricted, non-production Private Alpha v0.1.0 for architecture validation. It is not a production-ready autonomous-agent platform.

- Runtime baseline: Node.js 22+
- Language: TypeScript (strict mode)
- HTTP: Express 5
- Validation: Zod
- Logging: Pino with sensitive-field redaction
- Tests: Vitest, Supertest, and Node.js process tests
- Initial persistence: none

## Local installation and execution

```sh
nvm use
npm ci
npm run typecheck
npm run build
npm test
npm run test:process
npm start
```

The runtime listens on `127.0.0.1:3000` by default. Copy `.env.example` to `.env` only for local configuration. Do not commit real credentials or secrets.

## Initial API

- `GET /health` — process liveness only; it does not claim readiness, database health, dependency health, or module health.

Unknown routes return a JSON 404. The initial runtime does not register business modules or expose business operations.

**Do not expose this server to the public internet.** Authentication, authorization, tenant isolation, durable audit, production secret management, and deployment controls are not implemented.

## Architecture and security

- [Architecture overview](docs/architecture/overview.md)
- [Module boundaries](docs/architecture/module-boundaries.md)
- [Security baseline](docs/security/security-baseline.md)
- [Policy cancellation and runtime containment](docs/security/policy-cancellation-runtime-containment.md)
- [Private Alpha v0.1.0 scope and restrictions](docs/releases/private-alpha-v0.1.0.md)

Agent tool execution is deliberately unavailable. Blockchain functionality, when introduced, must remain read-only in the first release. Financial operations, wallet/private-key operations, privileged module execution, and unrestricted external API access are prohibited.

The default policy denies all requests, and the server does not configure an evaluator. The in-process FailClosedPolicyEngine validates and snapshots requests, but cancellation remains cooperative: a delegate that ignores AbortSignal can continue running. ProcessIsolatedPolicyEngine runs a policy module in a separate Node.js child process and can require confirmed process termination before accepting an Allow decision. This is a process boundary, not an operating-system sandbox; filesystem, network, identity, and resource restrictions still require deployment-level controls and independent security review. Do not use this starter runtime for sensitive or production workloads.

Shutdown Timeout Contract v6.2 remains outside this release implementation scope and is not changed by this branch.
