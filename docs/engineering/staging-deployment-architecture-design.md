# INFINYX Staging Deployment Architecture — Design

- **Status:** Proposed design; not implemented
- **Date:** 2026-11-27
- **Repository:** `hamidyaghobi70-beep/infinyx`
- **Branch:** `feat/adr-platform-foundation`
- **Related:** ADR-0011; `docs/engineering/keycloak-staging-implementation-plan.md`; `docs/engineering/phase-5a-ephemeral-keycloak-ci-integration.md`; Phase C1–C4 implementation records
- **Approval boundary:** Design and documentation only. This record does not authorize provisioning, configuration changes, code changes, database migrations, secret creation, deployment, merge, or release.

## 1. Executive decision

Use a **single-region, isolated staging environment** with three separately networked runtime components:

1. **INFINYX Web BFF** — the only application entry point; Node.js HTTP process behind a trusted HTTPS ingress/reverse proxy.
2. **Keycloak** — dedicated staging realm and confidential web client; public browser-facing HTTPS authorization endpoints, with administrative access restricted to VPN/allowlisted operators.
3. **PostgreSQL** — private database endpoint, not publicly reachable; separate staging database and least-privilege application role.

The browser reaches the BFF and the Keycloak authorization endpoints over HTTPS. The BFF reaches Keycloak discovery/token/JWKS endpoints and PostgreSQL over protected outbound/private connections. PostgreSQL accepts connections only from the BFF runtime network and explicitly authorized operator paths.

Do not combine staging with production identity, database, secrets, backups, or message-delivery credentials. Use synthetic identities and non-production data only.

This is a logical target architecture, not a provider/hosting selection. No cloud vendor, region, domain, VM/container service, managed database, or secret manager is selected by this document.

## 2. Logical topology

```text
                         Browser (synthetic test users)
                            |                 |
                    HTTPS app host     HTTPS identity host
                            |                 |
                            v                 v
                 +----------------+   +--------------------+
                 | Trusted HTTPS  |   | Keycloak staging   |
                 | ingress / edge |   | realm + web client |
                 +----------------+   +--------------------+
                            |                 ^
                    private HTTP             | HTTPS OIDC
                            v                 |
                 +----------------+----------+
                 | INFINYX Web BFF|
                 | Node.js process|
                 +----------------+
                            |
                      TLS / private
                            v
                 +--------------------+
                 | PostgreSQL staging|
                 | private endpoint  |
                 +--------------------+

       Operators -- VPN / identity-aware access --> admin surfaces
       CI          -- ephemeral isolated services --> test-only realm
```

The diagram is conceptual. The BFF must not be directly reachable from the public internet; only the trusted ingress may connect to its listener. Keycloak's browser-facing authorization endpoints need HTTPS reachability, but its administrative console and management interfaces must be separately restricted.

## 3. Network and trust boundaries

### 3.1 Public edge

- Reserve distinct HTTPS origins for the application and identity provider (for example, `app-staging.<approved-domain>` and `id-staging.<approved-domain>`); actual names require domain ownership and approval.
- Terminate TLS at a maintained ingress/load balancer with automated certificate renewal and modern TLS policy.
- Forward traffic to the BFF over a private network. Do not expose the BFF listener or Node.js port directly.
- Configure the ingress to overwrite, not append blindly to, forwarding headers. The BFF may trust forwarded protocol/host information only from the explicitly trusted proxy path.
- Reject unknown hostnames, malformed forwarding headers, and unexpected origins.
- Apply request-size, connection, and edge rate limits. Recovery initiation must have a stricter abuse-control policy before public exposure.
- Do not expose PostgreSQL, container control sockets, Keycloak management ports, or health/debug endpoints publicly.

### 3.2 BFF application subnet

- Run the BFF as a non-root service with a read-only application filesystem where practical, bounded CPU/memory, and restart supervision.
- Permit inbound traffic only from the ingress security identity/network.
- Permit outbound connections only to required dependencies: staging PostgreSQL, configured Keycloak OIDC endpoints, and approved telemetry/secret services.
- Keep the BFF's internal HTTP listener private. The current server uses Node.js HTTP; TLS is therefore an ingress responsibility in this design.
- Use at least one instance for initial staging. Do not assume horizontal scaling is safe until session, transaction, retry-worker, and deployment coordination behavior is explicitly tested. PostgreSQL-backed sessions remove process-local session dependence, but do not by themselves prove all multi-instance operational behavior.
- Run revocation retry workers under controlled concurrency. If multiple BFF instances are introduced, establish a documented singleton/lease or database-safe worker strategy and test duplicate execution before scaling.

### 3.3 Keycloak

- Deploy a dedicated, pinned, supported Keycloak version and a dedicated staging realm.
- Keep its database separate from the INFINYX application database, with a separate database role and credentials.
- Permit browser HTTPS access only to required user-facing authentication endpoints.
- Restrict admin console and management APIs to VPN or identity-aware operator access; require MFA for administrators where supported.
- Permit BFF-to-Keycloak HTTPS for discovery, token exchange, and JWKS. Validate TLS and exact issuer metadata; never disable certificate verification.
- Configure only exact redirect URIs and post-logout redirect URIs. Enumerate callback paths from the current route implementation before configuration. The recovery callback `/auth/account-recovery/callback` is a known required allow-list entry; do not use wildcard redirect URIs.
- Configure the BFF client as confidential, Authorization Code flow with PKCE S256, with implicit flow and direct access grants disabled unless a separately reviewed need exists.
- Define and test issuer, client ID, token audience/use, accepted algorithms, expiry, clock-skew, and logout contracts before enabling real staging login.
- Use synthetic users and test-only credentials. Do not connect real email/SMS delivery in this stage without a separate approval; prefer a local sink or controlled non-delivery test adapter.

### 3.4 PostgreSQL

- Use a dedicated staging cluster/database, not a production database or shared production cluster.
- Disable public network access. Restrict ingress to the BFF runtime and a narrowly controlled operator path.
- Require TLS with certificate validation. Current application configuration supports `DATABASE_SSL=require` with `rejectUnauthorized: true`; confirm the selected provider's certificate chain is trusted by the runtime. If a private CA is used, design an explicit CA distribution/configuration change before deployment; do not weaken verification.
- Use a dedicated `infinyx_app` role with only the grants required by the migrations and runtime. Do not run the application as database owner or superuser.
- Use a separate migration principal, available only to a controlled migration job/operator, not to the long-running BFF.
- Enable encrypted backups and point-in-time recovery if offered. Define retention, restore access, and deletion policy. A backup is not accepted until a restore exercise is completed and recorded.
- Do not restore production data into staging. Use synthetic fixtures or sanitized data with documented provenance and approval.

## 4. DNS, TLS, and cookie assumptions

- App and identity hosts must have valid public-trust TLS certificates. No self-signed certificate or CI localhost exception is permitted in persistent staging.
- The configured OIDC issuer must exactly match the issuer advertised by discovery metadata, including scheme, host, and path.
- The public BFF origin must be HTTPS and stable. The session cookie remains Secure, HttpOnly, host-scoped, and configured with the narrowest compatible SameSite policy.
- Verify callback URLs, cookie behavior, origin checks, and browser redirects through the actual ingress; local unit tests cannot prove proxy behavior.
- Do not put secrets, authorization codes, tokens, session IDs, or recovery transaction values in URLs beyond protocol-required authorization parameters; redact them from access logs and telemetry.
- DNS records and certificate issuance are future provisioning actions and are not created by this design.

## 5. Runtime configuration and secret handling

The current BFF runtime requires these configuration values (exact names verified in the existing application configuration):

| Variable | Staging handling |
|---|---|
| `OIDC_ISSUER` | Exact HTTPS issuer URL for the dedicated staging realm |
| `OIDC_CLIENT_ID` | Staging-only confidential client identifier |
| `OIDC_CLIENT_SECRET` | Secret-manager reference/injected secret; never commit or log |
| `OIDC_REDIRECT_URI` | HTTPS public callback origin/path accepted by the BFF and exact Keycloak allow-list |
| `PUBLIC_ORIGIN` | Exact HTTPS app origin |
| `SESSION_ENCRYPTION_KEY` | Secret-manager value; 32-byte key encoded as required by the application; staging-only |
| `DATABASE_URL` | Private staging PostgreSQL connection string; secret |
| `DATABASE_SSL` | Set to `require`; certificate validation remains enabled |
| `HOST`, `PORT` | Bind the BFF only on its private interface/listener as supported by the runtime topology |

Requirements:

- Select a secret manager before provisioning. Inject secrets at runtime using the platform's workload identity or equivalent; avoid plaintext environment files, repository secrets copied into hosts, image layers, and deployment logs.
- Separate secrets by environment and component. Keycloak bootstrap/admin credentials must not be reused as the BFF client secret or database credential.
- Generate high-entropy independent values. Do not reuse CI fixture secrets.
- Define rotation and emergency-revocation procedures for the OIDC client secret, database credential, and session encryption key before staging is considered operational. The current session encryption implementation has no documented key-version/rotation mechanism; do not rotate `SESSION_ENCRYPTION_KEY` in place without a separately designed compatibility/migration plan because existing encrypted sessions/transactions may become unreadable.
- Keep secret values out of GitHub issues, PRs, logs, screenshots, support tickets, and this document.
- Do not place real secret values in this architecture record.

## 6. Identity, account recovery, and application security

- Keep the BFF as the browser-facing authentication boundary. OAuth/OIDC tokens remain server-side; the browser receives only the opaque session cookie.
- Tenant selection is not authentication. Every tenant operation must continue to re-check active membership, role, and branch scope from INFINYX persistence.
- Preserve exact `(issuer, subject)` identity mapping. Never map or recover accounts by matching email, phone, display name, or browser-supplied user IDs.
- The account recovery callback must be explicitly allow-listed in Keycloak. Recovery initiation must be protected by edge rate limiting, abuse monitoring, and a reviewed security-notification channel before public staging exposure.
- No active linked identity means no automatic recovery under the current security policy. Do not add manual transfer, email/phone matching, or support override as a staging shortcut.
- Do not enable live email/SMS or connect production social/commerce/payment/advertising integrations in staging.
- Ensure CSRF/Origin protections work with the real public origin and proxy headers. Keep security headers and cookie policy enabled at the edge/application boundary.
- The current BFF has no built-in health/readiness endpoints or application-level request rate limiting. These are explicit operational gaps; do not infer their existence from ingress health checks.

## 7. Observability and operations

Minimum staging operations before external test access:

- **Health:** add or provide private liveness/readiness checks that distinguish process health from dependency readiness. Readiness should fail when mandatory startup dependencies are unavailable; health endpoints must not disclose secrets, versions with exploit value, database details, or identity data.
- **Logs:** structured, access-controlled logs with request/correlation IDs. Redact cookies, authorization headers, tokens, authorization codes, PKCE values, CSRF tokens, database URLs, and personal data.
- **Metrics/alerts:** BFF availability and latency; 4xx/5xx rates; OIDC discovery/token failures; PostgreSQL pool saturation/connection errors; session creation/refresh failures; pending outbox count/age/retry failures; recovery initiation and denial rates; backup age and restore-test status.
- **Audit:** retain security events with restricted access and defined retention. Avoid copying secrets or full tokens into audit payloads.
- **Runbooks:** startup/shutdown, dependency outage, Keycloak unavailable, database failover, pending revocation backlog, secret compromise/rotation, restore, rollback, and incident escalation.
- **Backups:** encrypted, access-separated, retention-defined, restore-tested. Test restore into an isolated environment, not over the active staging database.
- **Upgrades:** pin images by version/digest where supported; document Keycloak and PostgreSQL upgrade compatibility, maintenance windows, backup-before-upgrade, rollback limits, and evidence collection.

The existing retry loop is useful but is not a substitute for alerting. Pending session-revocation work must be observable and must never be reported as completed while pending.

## 8. Deployment and change-control sequence

This is a proposed future sequence. Each infrastructure/configuration action requires its own explicit approval and implementation plan.

1. **Environment and ownership:** choose provider, region, domain, data residency constraints, budget ceiling, operators, and escalation contacts.
2. **Network foundation:** create isolated staging network, ingress, private service connectivity, admin access boundary, and egress policy.
3. **Secret foundation:** select secret manager, workload identity, initial secret creation, access policy, and rotation/revocation runbooks.
4. **Data foundation:** create separate Keycloak and INFINYX staging databases/roles; configure TLS; establish encrypted backups and prove restore.
5. **Identity provider:** deploy pinned Keycloak, create isolated realm/client, configure exact redirect/logout URIs and token contract, restrict admin access.
6. **Application runtime:** build from reviewed branch commit, deploy BFF privately behind ingress, configure only staging secrets, and verify graceful shutdown/retry behavior.
7. **Security verification:** test full browser login/callback, CSRF, session cookies, logout, identity link/unlink, account suspension/revocation, recovery, rate limiting, and generic failure behavior through the actual ingress.
8. **Operational verification:** verify health/readiness, dashboards/alerts, backup restore, secret access, incident and rollback runbooks.
9. **Readiness review:** collect evidence and produce a proceed/revise/stop recommendation. No production inference is allowed from staging success.

Do not deploy directly from an unreviewed feature branch. Build artifacts should be traceable to an immutable commit and dependency lockfile; deployment approval should identify the exact artifact digest and configuration version.

## 9. Staging acceptance checklist

Staging is not ready for external testing until all applicable items are evidenced:

- [ ] Dedicated isolated staging account/project and network.
- [ ] Approved domain, DNS, valid TLS, and ingress-only BFF reachability.
- [ ] Keycloak user endpoints HTTPS; admin surfaces restricted.
- [ ] Dedicated Keycloak realm/client/database; exact callback/logout allow-lists.
- [ ] Dedicated INFINYX staging PostgreSQL database and least-privilege roles.
- [ ] TLS certificate chain validated by the BFF; no verification bypass.
- [ ] Secret manager and workload identity; no secrets in repository or logs.
- [ ] Session encryption-key rotation strategy or explicit documented operational constraint.
- [ ] Recovery rate limiting and security notification policy.
- [ ] Health/readiness, logs, metrics, alerts, and outbox backlog monitoring.
- [ ] Encrypted backup and successful isolated restore exercise.
- [ ] Synthetic-only test identities and data; no production integrations.
- [ ] End-to-end browser and security tests through the real ingress.
- [ ] Runbooks for outages, recovery, rollback, and incident response.
- [ ] Independent review of remaining high-risk findings and explicit acceptance of residual risks.

## 10. Known gaps and decisions still open

| Area | Current finding | Required decision/evidence |
|---|---|---|
| Hosting | No provider or region selected | Choose hosting and define cost/budget/ownership |
| Domain | No staging domain/DNS provisioned | Approve domain and naming |
| Ingress | BFF is Node HTTP; no ingress configured | Select trusted TLS ingress and proxy trust model |
| Keycloak | Only ephemeral CI integration exists | Select hosting, realm/client config, admin boundary |
| Recovery callback | Known callback path is not yet configured in a real client | Add exact URI after route inventory and approval |
| Rate limiting | No BFF dispatcher rate limiter | Trusted-edge policy and abuse tests |
| Notification | No verified security-notification channel | Select safe non-production channel or keep recovery unavailable |
| Database | No staging DB provisioned or inspected | Select provider, roles, TLS CA, backup and restore plan |
| Secrets | No secret manager selected | Select manager, workload identity, rotation and emergency response |
| Encryption rotation | No key-versioning/rotation support documented | Design compatible rotation before routine rotation |
| Health/readiness | No BFF health/readiness routes | Design and implement under separate code approval |
| Observability | No monitoring/alerting integration evidenced | Select stack, metrics, retention, alert ownership |
| Multi-instance | Not validated | Start single instance; prove worker/session coordination before scale-out |
| Governance | Existing branch ruleset has bypass/review gaps from prior review | Review required checks, approvals, bypass actors and deployment gates separately |

## 11. Explicit non-goals and approval gates

This design does **not** authorize:

- choosing or purchasing hosting/domain services;
- creating DNS, certificates, networks, VMs, containers, databases, buckets, or secret stores;
- editing Keycloak realms, clients, redirect URIs, users, or credentials;
- adding or changing application code, migrations, CI workflows, or repository policy;
- using production data, production credentials, live email/SMS, or real customer accounts;
- opening public access, running a deployment, merging PR #68, changing `main`, or releasing.

Next approval should be requested for a concrete **provider-neutral deployment decision record** or for a specific provider/hosting option comparison. After that, separate approvals are required for infrastructure provisioning, Keycloak configuration, database setup/migration, code changes, external exposure, and deployment.

## 12. Evidence basis and limitations

This design is based on read-only inspection of the feature branch and existing engineering records, including the BFF runtime configuration, Node HTTP server, OIDC route implementation, PostgreSQL pool configuration, session encryption, account-session revocation worker, Keycloak staging plan, and ephemeral Keycloak CI record.

The ephemeral CI Keycloak integration proves discovery/JWKS connectivity in a job-local environment only. It is not persistent staging and does not prove a full browser login, token exchange, refresh, logout, ingress behavior, or production readiness.

No live staging or production database, secret store, cloud account, DNS zone, Keycloak server, or deployment target was accessed or changed for this design. No infrastructure has been provisioned and no deployment has occurred.
