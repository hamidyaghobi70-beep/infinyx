# PostgreSQL Strict-TLS Local Validation — Implementation Record

- **Status:** Layer 1 implemented and CI-verified
- **Branch:** `feat/adr-platform-foundation`
- **Implementation commit:** `d185a06994358b8b30ab70cdb32c9a14d227dd49`
- **Related plan:** `docs/engineering/postgres-cloud-sql-strict-tls-validation-plan.md`
- **Scope:** Local deterministic TLS tests and PostgreSQL pool configuration hardening only

## 1. Delivered changes

### `src/persistence/postgres-pool.ts`

The PostgreSQL pool now:

1. Requires `DATABASE_SSL=require` by default.
2. Requires an explicit PEM CA certificate in `DATABASE_SSL_CA`.
3. Requires an explicit DNS certificate identity in `DATABASE_SSL_SERVERNAME`.
4. Validates that the supplied CA is actually a CA certificate.
5. Requires the TLS server name to be a valid DNS name, not an IP literal.
6. When the database URL host is a DNS name, requires it to match `DATABASE_SSL_SERVERNAME`. If the network host is an IP, an explicit DNS certificate identity may be supplied separately.
7. Always sets `rejectUnauthorized: true` for TLS connections.
8. Rejects all query parameter names beginning with `ssl` (case-insensitive) in `DATABASE_URL`, preventing `pg-connection-string` SSL URL options from replacing the application-owned TLS options.
9. Allows `DATABASE_SSL=disable` only for tests, or for local development when the database host is `localhost` or in IPv4 loopback `127.0.0.0/8`. Remote development, staging, and production database hosts cannot use this opt-out.

Configuration errors remain generic and do not include credentials or connection strings.

### `src/persistence/postgres-pool.test.ts`

Added deterministic TLS tests. Test certificates are generated in a temporary directory at test runtime with OpenSSL; no private key or reusable certificate fixture is committed.

Coverage includes:
- trusted CA + matching DNS SAN succeeds;
- untrusted CA is rejected;
- hostname/SAN mismatch is rejected;
- expired certificate is rejected;
- invalid/non-CA trust anchors are rejected;
- IP literals and invalid DNS server names are rejected;
- DNS URL host and TLS server identity mismatch is rejected;
- SSL query parameters such as `sslmode`, `sslrootcert`, `sslcert`, and `sslkey` are rejected;
- plaintext opt-out is restricted to tests or local loopback development.

### `.github/workflows/ci.yml`

The disposable CI PostgreSQL URLs no longer carry `sslmode=disable` query parameters. Test code selects the explicit local-only opt-out through the pool configuration instead. This keeps the test fixture consistent with the production rule that SSL policy must not be hidden in the connection URL.

## 2. CI verification

Latest implementation commit: `d185a06994358b8b30ab70cdb32c9a14d227dd49`

- Push workflow: [run #45964970516](https://github.com/hamidyaghobi70-beep/infinyx/actions/runs/45964970516) — **success**
- Pull request workflow: [run #45964977856](https://github.com/hamidyaghobi70-beep/infinyx/actions/runs/45964977856) — **success**
- TypeScript typecheck — passed
- Web BFF build — passed
- Unit and PostgreSQL integration suite — 31 test files, 207 tests passed
- Separate ephemeral Keycloak HTTPS discovery/JWKS integration — 1 test passed
- `npm audit` — 0 vulnerabilities
- CI disposable PostgreSQL migrations and existing security assertions — passed
- Ephemeral Keycloak and PostgreSQL containers — stopped by CI cleanup

Earlier CI attempts exposed test-fixture URL and environment mismatches. Those were corrected; the latest push and PR workflows above are green.

## 3. Runtime configuration contract

For strict direct TLS, configure:

- `DATABASE_URL`: PostgreSQL URL with no SSL-related query parameters.
- `DATABASE_SSL=require` (or omit it; this is the default).
- `DATABASE_SSL_CA`: trusted CA certificate in PEM format.
- `DATABASE_SSL_SERVERNAME`: expected DNS identity in the server certificate SAN.

Do not set `DATABASE_SSL=disable` outside test or local loopback development. Do not use `rejectUnauthorized: false`.

The exact CA mode, private DNS name, and certificate identity for a future Cloud SQL instance remain unselected and unverified.

## 4. Explicit limits

This work validates local Node.js TLS certificate and hostname verification behavior and guards the `pg` connection-string configuration path. It does **not** prove a live Cloud SQL connection or Cloud SQL certificate compatibility.

No Google Cloud project, API, VPC, Cloud SQL instance, IAM role, secret, billing configuration, DNS record, or cloud resource was created. No production or staging database was accessed. No Cloud SQL Connector was added. No deployment, merge, or release was performed.

## 5. Next approval boundary

The next step, if separately approved, is Layer 2 disposable Google Cloud proof using a private-only Cloud SQL test instance and synthetic credentials. It must not use a public IP or external database URL. Cloud provisioning and billing remain outside the authorization covered by this implementation.
