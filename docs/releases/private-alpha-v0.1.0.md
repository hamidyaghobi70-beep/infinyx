# INFINYX Private Alpha v0.1.0

**Release status:** Candidate for controlled architecture validation; not approved for public release or deployment.
**Baseline:** `fix/core-engine-shutdown-v6` at `2aab78817b50f48a4c8125b426e3b3d5bedaba44`.

## Purpose

This version validates that the TypeScript/Node.js modular-monolith foundation can be installed, built, started, observed at a minimal liveness endpoint, and tested repeatably. It is not a complete intelligence platform and does not provide production security guarantees.

## Supported runtime surface

- Node.js 22.12 or later.
- `npm ci` installation from the committed lockfile.
- TypeScript type checking and compilation.
- Automated unit/API tests and process lifecycle tests.
- HTTP server bound to loopback by default.
- `GET /health` reports process liveness only.
- Unknown routes return a generic JSON 404.
- Environment values are parsed and bounded through Zod.
- Structured logs use Pino with sensitive-field redaction.

No business modules are registered by the default server entry point. No database, durable queue, external event broker, or persistence adapter is configured.

## Explicit security restrictions

The following capabilities are not provided or must remain disabled:

- Autonomous Agent execution.
- External Tool execution or a Tool Gateway.
- Financial transactions or other sensitive external side effects.
- Wallet, private-key, signing, or asset-transfer operations.
- Privileged or untrusted module execution.
- Unrestricted outbound API/network access.
- Persistent memory or storage of user/tenant data.
- Any irreversible operation without a separately reviewed approval mechanism.

The default policy engine denies requests. The optional injected policy wrapper is not approved for sensitive authorization: `Promise.race()` enforces a response deadline but does not cancel or contain an evaluator that continues running after timeout. This limitation must not be interpreted as cancellation. No sensitive operation may rely on this wrapper.

## Authentication, authorization, and audit limitations

Authentication, authorization, tenant isolation, centralized abuse controls, durable audit storage, security monitoring, production secret management, and incident response are not implemented. Ordinary Pino logs are diagnostic logs and are not a durable audit record.

This runtime must remain on loopback or within an explicitly isolated development environment. Do not expose it to the public internet, process sensitive workloads, or treat `/health` as a security or readiness check.

## Shutdown boundary

This release branch does not modify the Shutdown Timeout v6.2 contract or implement timeout-policy changes. The v6.2 contract remains under its separate architecture/implementation hold. Existing lifecycle behavior and process tests are evaluated as-is; passing tests do not imply that the held timeout contract is approved.

## Reproducible verification

The release CI workflow is expected to run:

1. `npm ci`
2. `npm run typecheck`
3. `npm run build`
4. `npm test`
5. `npm run test:process`
6. `npm audit --audit-level=high`

The dependency audit is a security gate. Any failure must be recorded and investigated; it must not be bypassed or represented as a passing check. A green typecheck/build/test result does not replace dependency, policy, runtime-security, or independent architecture review.

## Private-alpha distribution boundary

The GitHub repository is currently configured as public. This branch does not change repository visibility, permissions, or create a distribution channel. Therefore, this document defines a restricted alpha capability set; it does not by itself make source code or artifacts private. Any actual invitation-only distribution requires a separately approved access-controlled mechanism before sharing artifacts.

## Release decision checklist

- [ ] Installation and runtime verified by CI.
- [ ] Typecheck and build pass.
- [ ] Unit/API and process lifecycle tests pass.
- [ ] Dependency audit reviewed with no unaccepted high/critical findings.
- [ ] Policy evaluator limitation explicitly accepted and sensitive operations remain unavailable.
- [ ] Authentication/authorization and durable audit limitations documented.
- [ ] Shutdown v6.2 hold preserved.
- [ ] Independent technical/security review completed.
- [ ] Founder separately approves any release or deployment.

A pull request is for review only. It does not authorize merge, tagging, public release, or deployment.
