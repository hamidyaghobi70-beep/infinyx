# INFINYX

**A Universe of Infinite Possibilities**

INFINYX is a Modular Autonomous Intelligence Platform. The approved starting point is a TypeScript/Node.js modular monolith, with explicit module boundaries and security controls.

## Repository status

This branch establishes the repository foundation. It is not a production-ready autonomous-agent platform.

- Runtime baseline: Node.js 22+
- Language: TypeScript (strict mode)
- HTTP: Express 5
- Validation: Zod
- Logging: Pino with sensitive-field redaction
- Tests: Vitest and Supertest
- Initial persistence: none

## Local development

```sh
nvm use
npm install
npm run typecheck
npm run build
npm test
npm start
```

The initial repository intentionally does not include a lockfile. Generate and review `package-lock.json` with the selected npm version, then use `npm ci` in CI before treating dependency resolution as reproducible.

Copy `.env.example` to `.env` for local configuration. Do not commit real credentials or secrets.

## Initial API

- `GET /health` — process liveness only; it does not claim database or dependency health.

The server binds to `127.0.0.1` by default. Do not expose it publicly until authentication, authorization, deployment controls, and an appropriate rate-limit strategy are implemented and reviewed.

## Architecture and security

- [Architecture overview](docs/architecture/overview.md)
- [Module boundaries](docs/architecture/module-boundaries.md)
- [Security baseline](docs/security/security-baseline.md)

Agent tool execution is deliberately unavailable. Blockchain functionality, when introduced, must remain read-only in the first release.
