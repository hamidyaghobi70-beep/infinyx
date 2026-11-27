# PostgreSQL and Cloud SQL Strict-TLS Compatibility Validation Plan

- **Status:** Proposed validation plan; no tests executed by this document
- **Date:** 2026-11-27
- **Repository:** `hamidyaghobi70-beep/infinyx`
- **Branch:** `feat/adr-platform-foundation`
- **Related design:** `docs/engineering/google-cloud-staging-architecture-design.md`
- **Decision owner:** INFINYX founder
- **Approval boundary:** Documentation only. This record does not authorize code changes, CI changes, cloud project creation, billing, resource provisioning, database access, secret creation, DNS changes, or deployment.

## 1. Purpose

Define a safe, repeatable validation plan for connecting the current INFINYX Node.js BFF to Google Cloud SQL for PostgreSQL while preserving two non-negotiable requirements:

1. PostgreSQL must be reachable only over private networking. Public database endpoints and public-IP fallback are prohibited.
2. TLS must provide both encryption and server identity verification. Certificate-chain verification and hostname verification are required. A setting that merely encrypts traffic without authenticating the server is insufficient.

The plan compares:
- direct PostgreSQL connection using `pg` with explicit strict TLS configuration;
- Google Cloud SQL Node.js Connector / Auth Proxy approach, using a private IP path.

No provider or connection method is approved by this plan.

## 2. Current repository baseline

Read-only review identified:

- `src/persistence/postgres-pool.ts` creates the PostgreSQL pool.
- The repository pins `pg` at `8.23.1`.
- Current runtime configuration exposes `DATABASE_SSL=require|disable`; TLS is enabled by default but can be disabled.
- The current pool passes a connection string and a TLS options object with `rejectUnauthorized: true`.
- There is no explicit CA bundle input or separately configured expected TLS server name in the current pool contract.
- Current tests do not sufficiently exercise SSL parameters embedded in the connection URL or prove hostname validation against a real certificate identity.

This baseline is not proof that Cloud SQL strict TLS currently works.

## 3. Security invariant and hard no-go conditions

A candidate implementation is acceptable only if all of the following hold:

- The database endpoint is private-only; Cloud SQL public IP is disabled and no public authorized network is configured.
- The BFF reaches the database through the approved VPC path.
- TLS is always enabled.
- The peer certificate chains to an explicitly trusted CA or to the authenticated connector trust mechanism.
- The server identity is validated. For direct TLS, hostname verification must match the expected DNS identity in the certificate SAN.
- Invalid, missing, expired, wrong-CA, or wrong-host certificates cause connection failure.
- There is no automatic insecure fallback and no retry against a public endpoint.
- Database connection errors and diagnostics never print credentials, full connection strings, tokens, or private key material.

Immediate no-go:
- any requirement to use `rejectUnauthorized: false`;
- `sslmode=require` as the sole security guarantee without identity verification;
- public database endpoint or external URL fallback;
- plaintext connection;
- certificate or hostname mismatch accepted;
- undocumented TLS behavior dependent on URL parsing side effects.

## 4. Important node-postgres behavior to validate

The node-postgres documentation warns that SSL-related parameters in a connection string (including `sslmode`, `sslrootcert`, `sslcert`, and `sslkey`) can replace the separately supplied `ssl` object when the connection string is parsed.

Therefore, the current pattern of passing both `connectionString` and `ssl` must not be assumed safe solely because the source contains `rejectUnauthorized: true`.

Before implementation:
1. Confirm the exact installed `pg` and `pg-connection-string` versions from the lockfile.
2. Review the matching package source/documentation for URL parsing behavior.
3. Build tests against the exact locked dependency versions.
4. Ensure the application owns TLS policy; untrusted or operator-mistyped URL query parameters cannot downgrade or replace it.
5. Reject unsupported/conflicting SSL URL parameters explicitly, or parse connection parameters separately and construct a controlled Pool configuration without allowing URL SSL fields to override policy.

The exact implementation technique is intentionally not selected in this document.

## 5. Candidate A — Direct `pg` with strict TLS

### Intended shape

- Connect to the Cloud SQL private DNS endpoint from a workload with private VPC connectivity.
- Use Node.js TLS options with certificate verification enabled.
- Supply a trusted CA bundle using the supported `ca` option.
- Supply the expected DNS hostname as the TLS server name when the connection host is not itself the certificate DNS identity.
- Do not use the private IP as the TLS server name unless the certificate explicitly includes that IP as a SAN.
- Keep the network destination private while validating the certificate against the expected DNS identity.

### Required proof

- The selected Cloud SQL CA mode issues a certificate compatible with the expected hostname.
- Private DNS resolves to the private endpoint from the actual runtime network.
- The current Node.js and `pg` versions perform chain validation and hostname validation with the proposed options.
- Connection-string parsing cannot override the TLS options.
- Certificate rotation can be handled without weakening verification.

### Advantages

- Keeps the application's PostgreSQL driver and Pool model.
- Provides direct control over CA trust and hostname verification.
- Avoids an additional connector process.

### Risks / open questions

- Cloud SQL CA mode and endpoint DNS behavior must be chosen precisely.
- CA distribution and rotation become application/runtime configuration responsibilities.
- The current `DATABASE_SSL` boolean-like contract is insufficiently expressive for explicit CA and server-name policy.
- Cloud SQL endpoint DNS name and certificate SAN compatibility must be proven, not inferred.

## 6. Candidate B — Cloud SQL Node.js Connector

### Intended shape

- Use the official Cloud SQL Node.js Connector with the PostgreSQL driver.
- Configure the connector to use private IP only.
- Authenticate the workload using its attached Google service identity / Application Default Credentials.
- Do not create or distribute long-lived service-account key files.
- Keep database username/password or IAM database authentication choice explicit and least-privileged.
- Do not enable public IP as a connector fallback.

### Required proof

- The exact connector version supports the selected Node.js runtime and `pg` version.
- Connector configuration explicitly selects private IP.
- Connector encryption and server/client identity verification meet the required threat model.
- The workload identity has only the required Cloud SQL Client / connection permissions.
- The connector connects only to the intended Cloud SQL instance and does not fall back to a public address.
- Connection pooling, refresh, shutdown, retry, and transient connector failure behavior are tested.
- The connector path works from the intended Cloud Run VPC egress topology.

### Advantages

- Google-managed certificate and connection identity handling.
- Reduces manual CA file distribution and certificate rotation burden.
- Integrates with workload identity.

### Risks / open questions

- Adds a library and connector lifecycle to the application.
- Requires precise IAM and private-IP configuration.
- Must prove that private networking is actually used in the deployed topology.
- Must verify pool lifecycle and connector resource cleanup under application shutdown and failure.

## 7. Test matrix

All tests must use synthetic credentials, synthetic records, and disposable infrastructure. No production or real staging database may be used for the initial proof.

| ID | Scenario | Expected result | Gate |
|---|---|---|---|
| U01 | URL without SSL query parameters | Strict TLS policy remains enabled | Unit |
| U02 | URL contains `sslmode=disable` | Configuration rejected; no connection | Unit |
| U03 | URL contains `sslmode=require` | Rejected or normalized without weakening identity checks | Unit |
| U04 | URL contains `sslrootcert`, `sslcert`, or `sslkey` | Explicit policy: reject or safely handle; no silent replacement | Unit |
| U05 | URL contains conflicting host/port/database values | Deterministic validation; no policy bypass | Unit |
| U06 | TLS configuration missing CA | Startup/config validation fails for direct-TLS mode | Unit |
| U07 | TLS hostname missing or malformed | Startup/config validation fails for direct-TLS mode | Unit |
| U08 | `DATABASE_SSL=disable` in staging mode | Startup rejected; no plaintext fallback | Unit |
| C01 | Valid private endpoint, trusted CA, matching hostname | Connection succeeds | Disposable Cloud SQL |
| C02 | Wrong CA | TLS handshake fails | Disposable Cloud SQL |
| C03 | Wrong hostname / SAN mismatch | TLS handshake fails | Disposable Cloud SQL |
| C04 | Expired or not-yet-valid certificate | TLS handshake fails | Controlled certificate fixture / supported endpoint |
| C05 | TLS disabled or plaintext attempt | Connection fails | Disposable Cloud SQL |
| C06 | Public IP disabled and private DNS route active | Connection succeeds only over private route | Disposable Cloud SQL |
| C07 | Public endpoint attempted | No public endpoint configured; attempt cannot succeed | Cloud configuration review |
| C08 | Connector configured private-only | Connector connects through private path | Disposable Cloud SQL |
| C09 | Connector identity/permissions removed | Connection fails closed | Disposable Cloud SQL |
| C10 | Connector restart/temporary network loss | Safe retry/recovery; no public fallback | Disposable Cloud SQL |
| P01 | Pool startup and shutdown | Connections and connector resources close cleanly | Integration |
| P02 | Concurrent connection demand | Pool limits respected; no credential leakage | Integration |
| P03 | Database unavailable | BFF fails safely; no insecure fallback | Integration |
| P04 | Logs on all failures | No secrets, full DATABASE_URL, tokens, or key material | Log review |

For C04, use a controlled local TLS fixture if Cloud SQL does not permit testing an expired certificate. Do not alter production or shared certificates to create this condition.

## 8. Test layers and execution order

### Layer 0 — Dependency and source verification (read-only)

- Confirm exact locked versions of `pg`, `pg-connection-string`, and any proposed Cloud SQL Connector.
- Review upstream documentation for those exact major/minor versions.
- Inspect how URL query parameters are parsed and how TLS options are merged.
- Confirm the current runtime Node.js version from CI and package metadata.
- Record findings before implementation.

### Layer 1 — Local deterministic tests (no cloud)

- Use a local test TLS server with a test CA and generated test certificates.
- Verify positive case: correct CA and DNS SAN.
- Verify negative cases: wrong CA, wrong hostname, expired certificate, missing CA, TLS disabled.
- Exercise all connection-string SSL parameter cases in U01–U08.
- Assert that failures occur before any fallback or retry to an alternate endpoint.
- Inspect captured logs for secret leakage.

### Layer 2 — Disposable Google Cloud proof (separate approval required)

Only after the local test suite passes and the owner separately approves cloud testing:
- create or use a dedicated disposable project with a strict budget cap;
- enable only required APIs;
- create a dedicated VPC and a private-only Cloud SQL test instance with public IP disabled;
- create synthetic database credentials and records;
- run the BFF test workload over the intended private network path;
- execute C01–C10 and capture redacted evidence;
- destroy disposable resources after evidence collection, subject to owner approval and retained audit evidence.

No cloud project, API, VPC, database, IAM binding, billing configuration, or test resource is created by this plan.

### Layer 3 — Staging acceptance (separate approval required)

After a provider and connection method are explicitly selected:
- execute the accepted tests in the dedicated staging environment;
- confirm no public database IP or authorized network exists;
- confirm TLS identity verification from the deployed BFF runtime;
- record CA rotation and connector lifecycle procedures;
- obtain a separate staging-readiness approval before any external use.

## 9. Acceptance criteria

A candidate is accepted only when:

1. U01–U08 all pass.
2. All applicable C01–C10 pass.
3. P01–P04 pass.
4. Cloud configuration evidence proves private-only database reachability and disabled public IP.
5. TLS evidence proves certificate-chain and hostname validation, not just encryption.
6. No test demonstrates an insecure fallback.
7. No secrets appear in logs or committed artifacts.
8. The implementation and operational runbook explain certificate/connector lifecycle and failure recovery.
9. Results are reproducible against the exact locked dependency versions.

If any mandatory negative test succeeds when it should fail, the candidate is rejected until fixed and retested.

## 10. Decision framework

| Outcome | Decision |
|---|---|
| Direct `pg` strict TLS passes all gates | Direct connection may be recommended |
| Direct TLS fails, Connector passes all gates | Connector may be recommended |
| Both pass | Prefer the lower operational-risk option with clear private-network evidence and maintainable rotation |
| Neither passes | Google Cloud architecture is no-go until redesigned; do not use public DB connectivity |
| Any method requires TLS downgrade or public fallback | Reject method |

This plan does not preselect a winner. Security acceptance takes precedence over convenience or price.

## 11. Evidence to retain

For each test run, retain:
- commit SHA and exact dependency lockfile hash;
- Node.js version and runtime platform;
- redacted configuration names (never secret values);
- test case IDs and pass/fail results;
- Cloud SQL CA mode and endpoint DNS identity;
- evidence that public IP is disabled;
- evidence of private DNS resolution and private route;
- redacted TLS verification result;
- connector version and IAM permission summary, if applicable;
- log-scrubbing review;
- cleanup result for disposable resources.

Do not commit private keys, live credentials, full connection strings, tokens, certificates containing private material, or customer data.

## 12. Explicit non-goals and approval boundary

This document does not authorize:
- modifying `src/persistence/postgres-pool.ts`, package manifests, lockfiles, tests, or CI;
- adding or installing a connector dependency;
- executing local or cloud tests;
- creating a Google Cloud project, enabling APIs, configuring billing, or provisioning resources;
- retrieving live CA material, secrets, database URLs, or credentials;
- connecting to any production or existing staging database;
- changing DNS, network, Keycloak, IAM, secrets, or firewall configuration;
- selecting Google Cloud as the final provider;
- deployment, public exposure, merge, or release.

**Next proposed step:** a separately approved implementation of Layer 1 local deterministic tests and the minimal configuration hardening needed to make TLS policy non-overridable. Cloud testing remains a separate approval gate.
