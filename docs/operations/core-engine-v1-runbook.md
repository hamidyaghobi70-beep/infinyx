# INFINYX Core Engine v1 — operational runbook

Status: **Stage 6 working draft; not production approval.** This runbook describes the
current repository behavior on the reviewed branch. It does not authorize merge, release,
deployment, Agent activation, or use with sensitive data.

## Runtime baseline

- Node.js: `>=22.12.0` (CI currently uses Node.js 22).
- Package manager: npm; install from the committed lockfile with `npm ci`.
- Build output: `dist/`; start command: `npm start` (runs `node dist/server.js`).
- Bind address defaults to `127.0.0.1:3000`. Configure with `HOST`, `PORT`,
  `NODE_ENV`, and `LOG_LEVEL`. `PORT` must be an integer from 1 to 65535.
- The current server composition creates a default `CoreEngine`; no authenticated
  principal provider, durable MemoryPort adapter, or AgentModule is wired into it.
- The HTTP app exposes `GET /health` (liveness) and `GET /ready` (Core lifecycle readiness),
  plus a JSON 404 for unknown routes.

## Safe local verification

From a clean checkout of the intended reviewed commit:

```sh
node --version
npm ci
npm run typecheck
npm run build
npm test
npm run test:process
npm audit --audit-level=high
```

Start locally only when intentionally testing the runtime:

```sh
HOST=127.0.0.1 PORT=3000 NODE_ENV=test npm start
curl --fail --silent http://127.0.0.1:3000/health
```

The health response is `{"status":"ok"}`. Stop the local process with SIGTERM and
confirm it exits after the server and Core Engine drain. Do not expose the development
listener to a public network.

## Liveness, startup, and readiness semantics

- The runtime installs SIGINT, SIGTERM, uncaught-exception, and unhandled-rejection
  handlers before Core initialization begins.
- Core initialization and start must complete before the HTTP listener is created.
- Consequently, a listening server implies the startup sequence completed successfully
  for that process. A process that fails startup should not be considered ready.
- `GET /health` confirms only that the HTTP process can answer a request. It does not
  independently inspect Core state, dependency health, storage, or downstream services.
- `GET /ready` returns `200 {"status":"ready"}` only while `CoreEngine.state === "running"`;
  otherwise it returns `503 {"status":"not_ready"}`. It reflects Core lifecycle only,
  not dependency, storage, or downstream-service health.
- A deployment platform must use `/ready` for Core lifecycle readiness and `/health` for
  process liveness; neither endpoint proves external dependency health.
- No durable storage or external dependency is currently composed into `src/server.ts`.

## Graceful shutdown

1. Send SIGTERM (preferred for an orchestrated stop); SIGINT is also handled.
2. The runtime closes HTTP admission via `server.close()` and waits up to
   `drainTimeoutMs` (default 10 seconds) for active HTTP connections.
3. On HTTP drain timeout, remaining HTTP connections are forcibly closed and the process
   exit code is set to 1.
4. Core Engine stop closes protected-operation admission, waits for policy shutdown and
   admitted protected operations within configured Core limits, then runs module cleanup.
5. Fatal `uncaughtException` or `unhandledRejection` events request shutdown and preserve
   a non-zero exit code.
6. The runtime shares the shutdown promise and invokes its exit callback once.

Operational checks:
- Confirm the process exits; do not assume a signal was successful solely because it was sent.
- Inspect structured logs for `Shutdown requested`, HTTP drain failures/timeouts,
  `Core Engine shutdown failed`, and fatal process errors.
- A non-zero exit or an unresolved Core drain is an incident requiring investigation.
- Do not restart-loop a process with unresolved state without preserving logs and diagnosing
  the cause.

## Security and data handling limits

- The default Core policy is deny. Do not weaken it to make a smoke test pass.
- The guarded memory implementation and in-memory reference store are not wired into the
  production server composition.
- `InMemoryMemoryStore` is volatile, plaintext, and not suitable for sensitive data.
- Partial Stage 4 library components now exist: AES-256-GCM encryption with an injected key-provider contract; a PostgreSQL memory adapter; a transactional hash-chain audit writer; least-privilege role SQL; a checksum/advisory-lock migration runner; and an external deletion-ledger replay contract.
- These components are not wired into `src/server.ts` or the live Core runtime. No concrete cloud KMS provider, external deletion ledger, backup/restore provider or restore drill, signed external audit checkpoint, authenticated identity composition, or live PostgreSQL/KMS integration has been verified. Do not configure or use the adapters with real data.
- Never place credentials, secrets, personal data, or regulated data in namespaces, keys,
  logs, or the in-memory reference store.
- Agent and external tool execution are not enabled by this runbook.

## Deployment and rollback gate

This document is not deployment authorization. Before any production deployment, the
project owner and independent reviewer must approve:
- the exact immutable commit and completed CI matrix;
- authenticated identity and tenant composition;
- completed persistent-storage security gates documented in
  `docs/security/memory-boundary-stage4.md`, including concrete KMS, independent deletion ledger,
  restore drill, trusted identity, and live integration evidence;
- a separate readiness/health contract and dependency failure policy;
- deployment resource limits, restart policy, connection limits, and rollback target;
- an incident-response owner and tested recovery procedure.

No deployment should proceed while any required gate is unknown or unverified.

## Current known gaps

- `/ready` reflects Core lifecycle only; dependency-aware readiness is not implemented.
- No production deployment manifest, resource limit, restart policy, or rollback automation
  is established by this runbook.
- No load, soak, or capacity measurements are recorded.
- No external identity provider or durable memory/audit backend is wired.
- CI evidence must be checked against the exact PR head SHA; evidence from earlier commits
  is historical and cannot certify later changes.
