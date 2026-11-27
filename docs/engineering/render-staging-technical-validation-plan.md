# Render Staging Technical Validation Plan

- **Status:** Proposed validation plan; not executed
- **Date:** 2026-11-27
- **Repository:** `hamidyaghobi70-beep/infinyx`
- **Branch:** `feat/adr-platform-foundation`
- **Related records:**
  - `docs/engineering/staging-deployment-architecture-design.md`
  - `docs/engineering/staging-deployment-decision-record.md`
- **Approval boundary:** Research and test-plan documentation only. No Render account, workspace, service, database, domain, secret, configuration, or deployment is created or changed.

## 1. Objective

Determine whether Render can host an isolated, persistent INFINYX staging environment without weakening current security properties.

The validation must prove all of the following before a provider selection is recommended:

1. Browser OIDC flows can reach Keycloak over HTTPS while Keycloak administration endpoints remain inaccessible to the public.
2. BFF-to-Keycloak and BFF-to-PostgreSQL traffic uses the intended private paths.
3. PostgreSQL TLS behavior is compatible with the current application's strict certificate validation.
4. Database roles, backups, restore, and deletion/retention behavior meet the staging requirements.
5. Secrets can be injected and rotated without committing or logging secret values.
6. Runtime health, revocation queue monitoring, and recovery abuse controls can be operated.
7. The total monthly cost is known for the exact topology and chosen plan.

This plan does not authorize provisioning or any live configuration.

## 2. Important findings from current Render documentation

### 2.1 Private service networking is available

Render services in the same region and workspace can communicate over a private network. Render Postgres provides an internal URL for private connections. Services should be co-located in the same region to use this path.

Source: https://render.com/docs/private-network

### 2.2 Critical PostgreSQL TLS compatibility question

Render documents two distinct PostgreSQL connection paths:

- **Internal URL:** available to services in the same Render account/workspace and region. Internal TLS is optional and uses self-signed certificates. Render says these connections do not support `sslmode=verify-ca` or `sslmode=verify-full`; `sslmode=require` encrypts the connection but does not verify the certificate.
- **External URL:** traverses the public internet, is always TLS-encrypted with Render-managed certificates, and supports external IP allow-lists. Render's connection tutorial states that the external certificate chain is trusted by normal OS/runtime CA stores and that `verify-full` is supported by compatible clients.

Sources:
- https://render.com/docs/postgresql-creating-connecting
- https://render.com/tutorials/postgres-on-render/connection-strings

INFINYX currently builds a `pg` pool with `ssl: { rejectUnauthorized: true }`. Its current design also requires a private database path. Therefore:

1. The Render **internal URL is not currently proven compatible** with the application's certificate-verification requirement. Do not silently downgrade to `sslmode=require`.
2. The Render **external URL is out of scope**: although it may support strict certificate validation, it traverses the public internet and violates the owner's mandatory private-database requirement. Do not evaluate it as a fallback.
3. Render's external URL commonly includes `sslmode=require`. The node-postgres documentation warns that SSL-related URL parameters such as `sslmode` replace the separately supplied `ssl` object. The current code's `rejectUnauthorized: true` therefore cannot be assumed to remain effective merely because it appears in the pool config. The URL parsing/configuration must be tested and, if necessary, sanitized so explicit strict TLS settings are preserved.

Relevant implementation evidence:
- `src/persistence/postgres-pool.ts` currently passes both `connectionString` and `ssl: { rejectUnauthorized: true }`.
- `pg` is pinned to version `8.23.1` in `package.json`.
- The current implementation has no explicit CA-bundle configuration.

Sources:
- https://node-postgres.com/features/ssl
- https://render.com/docs/postgresql-creating-connecting
- https://render.com/tutorials/postgres-on-render/connection-strings

Not acceptable:
- setting `rejectUnauthorized: false`;
- silently switching to unverified `sslmode=require`;
- disabling TLS;
- storing a production credential in a test.

**Decision gate:** The project owner has confirmed that private PostgreSQL connectivity is non-negotiable. If Render cannot provide a private connection with TLS certificate and hostname validation, Render is a **no-go** for this design. The external URL must not be used as a workaround, regardless of IP allow-listing.

### 2.3 PostgreSQL inbound access must be explicitly restricted

Render Postgres can have an inbound IP allow-list and external access can be disabled. Render's docs state that services in the same region can use the internal URL; external IP allow-lists apply to external connections, not private-network service-to-service traffic.

Source: https://render.com/docs/postgresql-creating-connecting

Validation must confirm the final database is not reachable over a public external endpoint unless a narrowly justified operator path is explicitly approved. The default allow-all rule must not be left in place.

### 2.4 Public web-service IP restrictions may require a higher plan

Render documents inbound IP rules for managed datastores on all workspaces, but inbound IP rules for web services require Scale or Enterprise. Private services and background workers do not receive public internet traffic.

Source: https://render.com/docs/inbound-ip-rules

This matters for Keycloak: browser-facing OIDC endpoints must be public over HTTPS, but the admin console and management APIs must not be public. A simple public Keycloak web service with no path-level control would not satisfy the design.

A candidate topology to validate is:
- Keycloak runs as a private service;
- a dedicated public HTTPS reverse-proxy service exposes only the exact OIDC/browser endpoints required;
- the proxy denies Keycloak admin, management, metrics, and other non-public paths by default;
- BFF-to-Keycloak administrative or back-channel traffic uses the private network;
- proxy rules are tested against the exact Keycloak version and endpoint inventory.

This proxy topology adds another service and another security-critical component. It is not assumed to be safe until tested. If path filtering cannot be robustly enforced and independently tested, Render is a **no-go**.

### 2.5 Paid database backup and restore behavior

Render documentation states paid Render Postgres supports point-in-time recovery. The recovery window currently depends on workspace plan: 3 days on Hobby and 7 days on Pro or higher. Logical exports can be created manually and are retained for seven days after creation. Free databases do not have Render's recovery capabilities.

Source: https://render.com/docs/postgresql-backups

Validation must check the actual plan's current recovery window, restore workflow, export behavior, storage cost, and deletion consequences. A successful backup indicator is not sufficient: an isolated restore exercise must be completed and documented.

## 3. Candidate Render topology

### 3.1 Candidate A — private Keycloak behind a public filtering proxy

| Component | Candidate Render service type | Public exposure |
|---|---|---|
| INFINYX BFF | Web service | Public HTTPS application origin |
| Keycloak | Private service | None directly |
| Keycloak edge proxy | Web service | Public HTTPS identity origin; strict route allow-list |
| INFINYX PostgreSQL | Render Postgres | Private internal connection; external access disabled |
| Keycloak PostgreSQL | Separate Render Postgres | Private internal connection; external access disabled |

All services must be in the same approved region and workspace for private networking. The Keycloak proxy must be a dedicated component with a deny-by-default route policy.

The BFF must never use a public database URL if a private, TLS-verified path is available. The BFF's public web endpoint is protected by the platform HTTPS edge; the app's Node.js listener remains HTTP behind that trusted edge.

### 3.2 Alternative B — public Keycloak service with platform IP restrictions

This alternative is only viable if the selected Render plan provides service-level inbound IP rules and there is a separate reliable method to expose user authorization endpoints while blocking administrative paths. IP allow-lists alone cannot distinguish public OIDC routes from admin routes on the same host.

Do not choose this topology merely because the plan includes inbound IP restrictions. A separate path-level enforcement layer and end-to-end negative tests are still required.

## 4. Validation work packages

### WP1 — Service and region compatibility

Read-only checks:
- Confirm supported service types for the intended Node.js BFF and pinned Keycloak container.
- Confirm private service availability and region co-location.
- Confirm private service hostname stability and DNS behavior across deploy/restart.
- Confirm whether the selected workspace/plan supports required environment/network isolation.
- Confirm current compute, disk, egress, backup, and workspace billing dimensions.

Acceptance:
- A written topology with exact service types and region.
- No dependency requires public access to the BFF listener, database, or Keycloak management interface.

### WP2 — Keycloak public/private route separation

Before any provider selection:

1. Pin the Keycloak version. The current ephemeral CI fixture uses Keycloak `26.3.3`; do not assume route behavior is identical across versions.
2. Inventory all required user-facing endpoints for the dedicated staging realm.
3. Follow Keycloak's documented reverse-proxy exposure guidance:
   - expose only the required `/realms/<staging-realm>/` endpoints;
   - expose `/resources/` and `/.well-known/` only as required by the tested browser/OIDC flows;
   - do not expose `/admin/`;
   - keep `/realms/master/` internal;
   - do not proxy management port `9000` (health/metrics).
4. Do not assume `hostname-admin` alone protects the Admin REST API. Keycloak explicitly states that the Administration REST API can still be reached through the frontend hostname; enforce restrictions at the reverse proxy.
5. Use a reverse proxy mode that can inspect/filter HTTP paths. Keycloak recommends TLS re-encryption for production proxying; it allows path filtering and header handling. Restrict Keycloak network access to the trusted proxy, overwrite (not append) forwarded headers, and configure trusted proxy addresses.
6. Verify issuer and discovery URLs remain consistent with the public identity hostname. The current BFF discovers endpoints from one configured issuer and validates HTTPS for authorization, token, and JWKS URLs; it has no separate private backchannel endpoint configuration. Do not assume BFF token/JWKS traffic will use a private Keycloak address.
7. Test normal browser login/logout and all required BFF OIDC flows through the public identity origin.
8. Test negative cases from an unauthenticated external client: `/admin/`, `/realms/master/`, management port `9000`, metrics, health, debug, unknown paths, and non-staging realms must be inaccessible.
9. Confirm no other service on the same Render private network can bypass the proxy. Render private networking is shared by services in the same workspace and region; it is not automatically a per-service firewall. A dedicated workspace/network boundary or an equivalent verified control may be needed.

Keycloak references:
- https://www.keycloak.org/server/reverseproxy
- https://www.keycloak.org/server/hostname

Acceptance:
- Required staging-realm OIDC flows work.
- Administrative and management paths are inaccessible from the public internet.
- Direct access to Keycloak bypassing the proxy is blocked or structurally impossible.
- Forwarded headers are overwritten and accepted only from trusted proxy sources.
- No wildcard route or wildcard redirect URI is required.
- The proxy route policy is version-controlled, reviewed, and independently testable.

Stop condition:
- If Keycloak's required endpoints cannot be separated from administrative endpoints with a reliable default-deny policy, Render is not acceptable for this design.

### WP3 — PostgreSQL private path and strict TLS

1. Confirm both databases can be placed in the same region as their dependent services.
2. Obtain the provider's internal and external connection details using synthetic credentials only.
3. For the internal URL, verify whether a supported CA/certificate-validation mechanism exists. The documented self-signed internal certificate behavior currently conflicts with standard `verify-ca`/`verify-full` requirements.
4. For the external URL, inspect the certificate chain and hostname identity and test strict verification using the Node.js runtime trust store.
5. Inspect the final connection string for `sslmode`, `sslrootcert`, `sslcert`, and `sslkey`. Ensure these parameters do not silently override the explicit TLS configuration passed to node-postgres.
6. Test the actual pinned `pg@8.23.1` behavior with `rejectUnauthorized: true`; test both trusted certificate and deliberately untrusted/mismatched-certificate failure cases.
7. Verify database inbound external access is disabled; do not propose an external URL or public-IP allow-list as an alternative to private connectivity.
8. Verify unauthorized external sources are rejected at the database network boundary.
9. Verify the BFF uses the least-privilege application role and never a database owner/superuser credential.

Acceptance:
- The selected connection path uses TLS with certificate-chain and hostname validation.
- The node-postgres configuration is proven to preserve strict verification after parsing the actual provider URL.
- The database connection must use a private URL; an external URL is prohibited by the approved architecture decision.
- External database access is disabled.
- No superuser/owner credential is used by the BFF.

Stop condition:
- Do not set `rejectUnauthorized: false`, and do not silently downgrade to unverified `sslmode=require`.
- If Render's internal endpoint cannot satisfy strict certificate validation, stop the Render evaluation and mark Render no-go. Do not fall back to external TLS + source-IP allow-listing.

### WP4 — Database roles and migrations

- Provision separate staging data stores for INFINYX and Keycloak only after separate authorization.
- Create an application role limited to runtime grants.
- Create a separate migration role used only by a controlled migration task.
- Confirm migration execution order through migration 015 and verify all current migration preflight/rollback protections.
- Verify the BFF cannot create roles, alter unrelated schemas, or bypass the intended RLS/least-privilege controls.
- Test migrations on a disposable empty staging clone before any persistent staging database is used.
- Do not copy production data.

Acceptance:
- Role grants are captured and reviewed.
- Application role is not superuser or schema owner.
- Migration evidence and rollback limitations are documented.

### WP5 — Backup, restore, and retention

1. Confirm exact backup/PITR retention for the chosen plan and both databases.
2. Confirm whether Keycloak database backups are covered identically to INFINYX Postgres.
3. Create an on-demand logical export for each database in a disposable test.
4. Restore to a new isolated database, never over the active staging database.
5. Verify schema, row counts, identity records, account security lifecycle history, outbox records, and Keycloak realm state.
6. Record RPO/RTO measured by the exercise.
7. Confirm deletion of a database and its backups behavior; export anything that must survive before deletion.
8. Define retention and access control for exported backups.

Acceptance:
- Successful isolated restore is evidenced for both databases.
- Recovery window meets an explicitly chosen staging objective.
- Backups are not accessible to ordinary application credentials.

### WP6 — Secrets and runtime configuration

Verify:
- secret injection method and access boundaries;
- workload identity or equivalent where supported;
- separate Keycloak bootstrap/admin, OIDC client, INFINYX DB, Keycloak DB, and session encryption secrets;
- no secret values in Git, build logs, deployment logs, or support artifacts;
- rotation procedure for each credential;
- session encryption key compatibility/rotation strategy.

The current session encryption implementation has no documented key-version rotation. Do not rotate `SESSION_ENCRYPTION_KEY` in place until a compatible migration/rotation design is separately approved and tested.

Acceptance:
- Secret access is limited to the required service/operator.
- Rotation and emergency revocation are documented and testable.
- No production credentials are used.

### WP7 — Operations, monitoring, and abuse protection

Verify:
- private liveness/readiness mechanism; current BFF does not expose built-in health/readiness routes;
- logs redact tokens, cookies, authorization codes, CSRF values, connection strings, and personal data;
- alerts for BFF errors/latency, OIDC failures, DB saturation, outbox backlog/age, recovery denials, and backup age;
- recovery initiation rate limiting at a trusted edge;
- verified non-production security notification channel or recovery disabled;
- graceful shutdown and revocation retry behavior;
- runbooks for provider outage, Keycloak outage, DB recovery, secret compromise, and rollback.

Acceptance:
- Alerts are exercised, not merely configured.
- Pending revocation work cannot silently accumulate without alerting.
- Recovery cannot be exposed before rate limiting and notification prerequisites are met.

### WP8 — Cost and ownership

Produce a final quote using the exact topology:
- BFF compute;
- Keycloak compute;
- Keycloak proxy compute;
- two PostgreSQL services and storage;
- backups/exports;
- egress and IPv4 where applicable;
- workspace/plan requirements for IP restrictions or environment isolation;
- monitoring/logging;
- tax and payment fees.

Set a monthly budget ceiling and alert threshold before creating any resources. Assign an operator for updates, backup verification, incident response, and billing review.

Acceptance:
- Written monthly estimate and budget owner.
- No unbounded usage-based component without an alert/limit strategy.
- Provider terms, region, and data-processing requirements reviewed.

## 5. Go / no-go decision gates

| Gate | Required evidence | Failure outcome |
|---|---|---|
| G1 Private networking | BFF/Keycloak/DB same-region private paths | No-go |
| G2 Keycloak admin isolation | External negative tests deny all admin/management routes | No-go |
| G3 Strict DB TLS | Actual `pg@8.23.1` connection proves certificate and hostname validation | No-go until approved fix |
| G3a Private DB path | Private URL meets TLS policy; external database URL is prohibited | No-go |
| G4 Database access | External access disabled/restricted; least privilege | No-go |
| G5 Backup/restore | Successful isolated restore of both DBs | No-go |
| G6 Secrets | Runtime injection, access boundaries, rotation plan | No-go |
| G7 Operations | Health, alerts, outbox monitoring, runbooks | No-go for external testing |
| G8 Recovery controls | Edge rate limit and notification path | Recovery remains disabled |
| G9 Cost/ownership | Budget and accountable operator | No-go for provisioning |

A provider can be selected for a limited internal proof of concept only after G1–G4 and cost/ownership are accepted. External tester access requires all applicable gates, including backup/restore and operations.

## 6. Proposed execution order after separate approval

1. Approve a disposable Render proof-of-concept scope and budget ceiling.
2. Create only temporary test services with synthetic credentials/data.
3. Validate private service routing and Keycloak proxy path restrictions.
4. Validate strict PostgreSQL TLS with the existing BFF code.
5. Validate database roles and migrations against disposable databases.
6. Validate backup/export and isolated restore.
7. Destroy the proof-of-concept only after confirming required evidence has been retained and no data needs preservation.
8. Publish a go/no-go report and updated monthly estimate.
9. Request a separate approval before creating persistent staging.

Each step that creates services, uses a paid plan, or changes provider configuration requires explicit authorization.

## 7. Current recommendation

Render remains a **conditional candidate, not an approved provider**.

Three high-risk technical questions must be resolved first:
1. Keycloak's public OIDC surface must be separated from admin/management paths using a robust deny-by-default proxy. Keycloak documents the public/private path split and explicitly warns that `hostname-admin` alone does not block the Administration REST API on the frontend hostname.
2. Render's internal PostgreSQL URL uses optional self-signed TLS and does not support standard `verify-ca`/`verify-full`. The external URL supports trusted TLS but traverses the public internet. This creates a real trade-off against INFINYX's private-database requirement.
3. The current node-postgres configuration must be tested with the actual Render connection URL: URL-level SSL parameters can replace the explicit `ssl` object, so strict verification is not proven by reading `rejectUnauthorized: true` in isolation.

Private PostgreSQL connectivity is now an owner-approved non-negotiable requirement. If Render cannot satisfy private networking and strict TLS certificate validation together, Render is a **no-go** and another provider must be evaluated. Public/external PostgreSQL connectivity is not an acceptable workaround. If any requirement can only be met by weakening TLS verification or leaving administrative routes public, stop the Render path.

## 8. Sources

- Render Postgres create/connect, internal TLS, external TLS, and IP allow-lists: https://render.com/docs/postgresql-creating-connecting
- Render Postgres connection-string and TLS-mode details: https://render.com/tutorials/postgres-on-render/connection-strings
- node-postgres TLS configuration and connection-string parsing: https://node-postgres.com/features/ssl
- Render private networking: https://render.com/docs/private-network
- Render outbound IP ranges: https://render.com/docs/outbound-ip-addresses
- Render inbound IP rules and plan requirements: https://render.com/docs/inbound-ip-rules
- Keycloak reverse-proxy path exposure, TLS re-encryption, and trusted proxy guidance: https://www.keycloak.org/server/reverseproxy
- Keycloak hostname/admin endpoint behavior: https://www.keycloak.org/server/hostname
- Render Postgres backup and recovery: https://render.com/docs/postgresql-backups

## 9. Explicit non-goals

This plan does not authorize:
- creating a Render account/workspace or starting a trial;
- accepting paid terms or making a payment;
- creating services, databases, volumes, domains, DNS records, or certificates;
- generating, uploading, or changing any secret;
- configuring Keycloak, proxy routes, PostgreSQL, or BFF environment variables;
- modifying application code, migrations, CI, or repository policy;
- using real user data or production credentials;
- enabling public external testing;
- merging PR #68, changing `main`, deploying, or releasing.

No Render resource has been created and no live Render environment has been tested as part of this document.
