# INFINYX Google Cloud Staging Architecture — Design Proposal

- **Status:** Proposed design; not approved for provisioning
- **Date:** 2026-11-27
- **Repository:** `hamidyaghobi70-beep/infinyx`
- **Branch:** `feat/adr-platform-foundation`
- **Decision owner:** INFINYX founder
- **Related records:**
  - `docs/engineering/staging-deployment-architecture-design.md`
  - `docs/engineering/staging-deployment-decision-record.md`
  - `docs/engineering/render-staging-technical-validation-plan.md`
- **Approval boundary:** Architecture research and documentation only. No Google Cloud project, billing account, resource, secret, domain, DNS, certificate, database, Keycloak realm/client, code, CI, or deployment is created or changed.

## 1. Executive recommendation

Use Google Cloud as the leading candidate for a controlled staging environment, subject to hands-on validation before provider selection.

Proposed service layout:

- **INFINYX BFF:** Cloud Run service, exposed only through an external HTTPS Application Load Balancer; Cloud Run ingress set to `internal-and-cloud-load-balancing`, and the default `run.app` URL disabled after the load-balancer path is validated.
- **Keycloak:** a separate service and identity boundary, preferably a dedicated Compute Engine VM or a separately isolated Cloud Run service behind its own HTTPS load-balancer backend. Public OIDC endpoints are exposed; administrative routes are protected by a separately tested access policy. Do not rely on `hostname-admin` alone as an access-control boundary.
- **INFINYX PostgreSQL:** Cloud SQL for PostgreSQL, private connectivity only, with public IP disabled.
- **Keycloak PostgreSQL:** separate Cloud SQL instance preferred for staging isolation. A separate database and database role in a shared instance may be considered only as a documented cost-saving exception after threat and blast-radius review.
- **Network:** one dedicated VPC and subnet plan, Direct VPC egress for Cloud Run services that need private VPC access, narrow firewall rules, and private DNS.
- **Secrets:** Secret Manager with separate service accounts and least-privilege secret access.
- **Operations:** Cloud Logging/Monitoring, budget alerts, automated backups, and a restore exercise before external testing.

This is a candidate architecture, not a provider selection or deployment authorization.

## 2. Non-negotiable security requirements

1. INFINYX PostgreSQL has no public IP and is reachable only over private network paths.
2. PostgreSQL transport encryption and server identity verification are both mandatory. TLS encryption without certificate trust and hostname verification is insufficient.
3. No `rejectUnauthorized: false`, no plaintext database connection, and no public database URL fallback.
4. BFF is reachable from the internet only through the approved HTTPS load balancer; direct Cloud Run URL access is disabled or blocked.
5. Keycloak's public OIDC endpoints and administrative endpoints have distinct access policies. Administrative APIs and consoles must not be internet-accessible.
6. BFF, Keycloak, and each database use separate service identities and credentials.
7. Staging uses synthetic accounts and data only; no production DB, production identity realm, or live business integrations.
8. No service account key files are committed to Git. Prefer attached workload identities and short-lived credentials.
9. Recovery endpoints remain disabled for external testing until trusted-edge rate limiting and a reviewed security-notification path are available.
10. No provider convenience feature may weaken tenant isolation, identity lifecycle controls, auditability, or least-privilege database grants.

## 3. Logical topology

```text
                         Internet
                            |
                    HTTPS / custom domain
                            |
                 External Application LB
                    /                 \
          BFF backend                 Keycloak backend
       Cloud Armor policy          OIDC route policy
              |                         |
       Cloud Run: BFF              Keycloak service
       ingress: LB-only            separate runtime
       default URL off             admin route restricted
              |                         |
       Direct VPC egress           Private VPC interface
              |                         |
       Dedicated VPC + private DNS + firewall policy
              |                         |
       Cloud SQL PostgreSQL       Cloud SQL PostgreSQL
       INFINYX data (private)     Keycloak data (private)
       public IP disabled         public IP disabled

       Secret Manager + service accounts
       Cloud Logging / Monitoring / budgets
```

The diagram is conceptual. The exact load-balancer URL map, Keycloak admin route enforcement, and private service reachability must be proven in a disposable test project before any persistent staging environment is approved.

## 4. Component decisions

### 4.1 INFINYX BFF — Cloud Run

**Proposed configuration**
- Deploy the existing BFF container as a Cloud Run service.
- Use an external HTTPS Application Load Balancer and serverless NEG as the only public ingress path.
- Set Cloud Run ingress to `internal-and-cloud-load-balancing`.
- Disable the default `run.app` URL once the custom-domain/load-balancer path is verified.
- Attach the service to the dedicated VPC using Direct VPC egress.
- Initially route only private-range traffic through the VPC; route all egress through VPC only if a documented egress-control requirement justifies Cloud NAT and its additional cost.
- Set minimum instances deliberately: scale-to-zero reduces cost but can increase first-request latency; a minimum instance increases predictable availability and cost.
- Keep BFF session storage and cryptographic behavior in the existing application design; do not rely on local container filesystem for durable state.

**Ingress security**
- HTTPS terminates at the Google Cloud load balancer.
- Cloud Armor can provide edge policy and rate-limiting controls where supported by the selected load-balancer/backend configuration.
- Trust forwarded headers only from the known load-balancer path. Direct public access to the Cloud Run URL must not remain as a bypass.
- Add health/readiness endpoints in a separately authorized code change; this design does not add them.

**Important implementation gap**
The repository's current BFF server uses Node's HTTP server and expects TLS termination at a trusted proxy. This topology is compatible only if the proxy-to-container path and forwarded-header trust are explicitly validated. No application code is changed by this design.

### 4.2 Keycloak — isolated identity service

Keycloak is security-critical and must not share the BFF's runtime identity or database credentials.

**Preferred staging shape**
- Run one dedicated Keycloak instance/service in the same selected region and VPC boundary.
- Use a separate Cloud SQL PostgreSQL instance for Keycloak.
- Keep Keycloak administration accessible only through a restricted administrative path (for example, IAP-protected access or a private administrative entry point).
- Expose only the OIDC endpoints needed by browser login and callbacks.
- Use a dedicated staging realm and confidential client; never reuse production credentials.
- Configure exact redirect URI allow-lists, including the recovery callback `/auth/account-recovery/callback`, only after the recovery controls are approved.
- Keep management, health, metrics, and administrative endpoints unavailable from the public OIDC frontend.

**Admin/public route separation is a go/no-go test**
Keycloak's hostname settings are not, by themselves, a network authorization control. The selected topology must demonstrate that:
- unauthenticated public clients can reach only the required realm OIDC endpoints;
- the admin console and Admin REST API are denied from the public path;
- authorized operators can reach administration through the restricted path;
- management port 9000 and internal metrics are not exposed publicly;
- no alternate hostname, default URL, or direct service address bypasses the policy.

A path-based load-balancer policy, a separate private admin ingress, or a dedicated reverse proxy may be used, but the exact design must be tested. If the route split cannot be demonstrated reliably, do not expose Keycloak publicly.

**Runtime choice remains open**
A single Compute Engine VM gives explicit control over reverse proxy and network interfaces but adds OS operations. Cloud Run can reduce host administration but requires careful route separation and runtime validation. The design does not select between them yet.

### 4.3 INFINYX PostgreSQL — Cloud SQL for PostgreSQL

**Network**
- Prefer Private Service Connect or private services access after checking the chosen Cloud Run connectivity path and region.
- Cloud Run BFF connects using Direct VPC egress to the private endpoint.
- Disable public IP. Do not add authorized public networks.
- Keep database ingress restricted to the BFF service network identity/tag path as narrowly as supported by the selected Cloud SQL networking model.
- Create a private DNS record for the Cloud SQL instance DNS identity when required by the TLS verification mode.

**TLS and identity verification**
- Require TLS at the database instance.
- Use a Cloud SQL server CA mode that supports the intended hostname verification path. The current documented options differ:
  - Per-instance CA can verify server identity by CA for the instance; DNS-name verification is available for PSC-configured instances.
  - Shared CA requires both CA validation and hostname verification; the Cloud SQL DNS name must resolve in the private network.
  - Customer-managed CA supports a managed trust chain and custom SAN names, but adds CA lifecycle responsibilities.
- For direct PostgreSQL connections, use a strict verification mode equivalent to `verify-full`: validate the trusted CA chain and the server hostname.
- Do not use a raw private IP as the TLS hostname unless the certificate explicitly contains that IP SAN.
- Confirm the selected Cloud SQL endpoint DNS name and certificate SAN match exactly.
- The alternative Cloud SQL Auth Proxy / Language Connector path provides encrypted connections and server/client identity verification, but the chosen connector and private endpoint behavior must be tested with the current Node.js runtime and deployment shape.

**Compatibility with current repository**
The current persistence configuration supports `DATABASE_SSL=require` or `disable`, and its PostgreSQL pool constructs a TLS configuration with certificate verification enabled. That alone does not establish that the current configuration performs hostname verification against the Cloud SQL certificate identity or loads the correct CA bundle.

Before deployment, a separate, explicitly approved implementation/test step must:
1. inspect the exact installed `pg` version and current pool configuration;
2. choose direct private TLS with CA + hostname verification, or a supported Cloud SQL connector;
3. prove that connection-string SSL parameters cannot silently override the intended TLS object;
4. prove wrong CA, wrong hostname, expired certificate, and plaintext attempts all fail;
5. ensure no insecure fallback exists.

No changes to the database pool or environment-variable contract are included in this design.

### 4.4 Keycloak PostgreSQL

- Use a separate Cloud SQL PostgreSQL instance for Keycloak where budget permits.
- Disable public IP and use private networking.
- Use a separate service account, database role, secret, backup policy, and access audit.
- Do not let the BFF service account read Keycloak database credentials or vice versa.
- Do not share the INFINYX application database role with Keycloak.
- If a single Cloud SQL instance is considered to reduce staging cost, create separate databases and roles and record the accepted shared-instance failure/blast-radius risk before approval.

### 4.5 Network and identity boundaries

- Dedicated VPC for staging; do not peer with production networks.
- Private subnet address ranges must be planned to avoid overlap with future VPN or office networks.
- Direct VPC egress for Cloud Run is the preferred initial outbound path; apply network tags and firewall rules where supported.
- Public ingress is limited to HTTPS load balancers.
- Administrative access uses IAP or a private operator path with MFA and individual identities.
- Each workload has a distinct Google service account:
  - BFF runtime identity;
  - Keycloak runtime identity;
  - migration job identity;
  - operations/read-only observability identity.
- Runtime identities receive only the secrets and APIs required by that service.
- Database schema migrations use a separate migration principal, never the runtime application DB role.

### 4.6 Secrets and cryptographic keys

Use Secret Manager for:
- Keycloak client secret;
- database credentials if password authentication is retained;
- session encryption key;
- any CA bundle or connector configuration that must be distributed as a secret/config artifact.

Prefer workload identity / attached service accounts over downloaded service-account keys.

The existing INFINYX session encryption key has no version-aware rotation mechanism in the current implementation. Therefore:
- do not rotate it in place during initial staging setup;
- define a versioned key migration and rollback plan before rotation;
- never print secret values in CI logs, deployment logs, or diagnostics;
- use separate staging-only keys and credentials.

### 4.7 Backups and recovery

For both PostgreSQL instances:
- enable automated backups with a documented retention window;
- assess point-in-time recovery requirements and cost;
- define a separate export path for logical backups if required;
- encrypt backup exports and restrict access;
- run a restore exercise into a separate disposable instance;
- record restore duration, integrity checks, and operator steps;
- do not claim backup readiness until a restore has been demonstrated.

### 4.8 Observability and operations

Minimum staging controls:
- Cloud Logging with structured, redacted application logs;
- Cloud Monitoring dashboards and alerts for service availability, 5xx, latency, CPU/memory, database connections/storage, and outbox retry age;
- alerts for failed or repeatedly pending session-revocation outbox items;
- budget alerts and review of actual spend;
- audit logs for administrative IAM, secrets access, database changes, and Keycloak administration;
- runbooks for deployment rollback, database restore, secret rotation, Keycloak outage, and account/session revocation incident.

Do not log access tokens, ID tokens, session cookies, passwords, database URLs, secret values, or full recovery transaction payloads.

## 5. Region and data-residency decision

No region is selected in this document.

Before selection:
- compare Cloud SQL, Cloud Run, load balancer, Secret Manager, and Keycloak VM availability in the same region;
- assess latency to the intended user population and external OIDC identity dependencies;
- review Google Cloud data-processing, support, and data-location terms;
- ensure BFF, Keycloak, and databases are co-located where practical to reduce latency and network cost;
- record the reason for the selected region and any cross-region data movement.

Do not infer that a European user location automatically requires or guarantees a particular Google Cloud region.

## 6. Cost model — no quote approved

The cost estimate must include, at minimum:

| Cost component | Main driver |
|---|---|
| Cloud Run BFF | vCPU/RAM allocation, request volume, minimum instances |
| Keycloak runtime | VM or Cloud Run sizing, uptime, persistent disk if VM |
| INFINYX Cloud SQL | vCPU, memory, storage, backups/PITR, HA choice |
| Keycloak Cloud SQL | separate instance sizing, storage, backups |
| External HTTPS load balancer | forwarding rules, data processing, certificates/features |
| Cloud Armor | policy tier, requests, rules |
| VPC / NAT / egress | Direct VPC egress, Cloud NAT if required, cross-region and internet egress |
| Secret Manager | active secret versions and access operations |
| Logging/Monitoring | ingestion, retention, metrics, alerting |
| Backup/export storage | retention and restore-test copies |
| Taxes/support | billing country, support tier, VAT/tax treatment |

Official pricing references:
- Cloud Run: https://cloud.google.com/run/pricing
- Cloud SQL: https://cloud.google.com/sql/pricing
- Secret Manager: https://cloud.google.com/secret-manager/pricing
- Google Cloud pricing calculator: https://cloud.google.com/products/calculator

No fixed monthly total is stated because region, machine sizes, database edition/HA, storage, retention, traffic, and Keycloak runtime are not selected. A cost worksheet must be prepared from the chosen region and measured staging load before a purchase decision.

## 7. Validation gates before provider selection

The following are required, in order:

### Gate G1 — Architecture and region
- Confirm Cloud Run, Cloud SQL, load balancing, Secret Manager, and chosen Keycloak runtime are available in the candidate region.
- Confirm whether the selected Cloud SQL private connectivity is Private Service Connect or private services access.
- Verify private DNS resolution from the Cloud Run VPC egress path.

### Gate G2 — PostgreSQL private TLS proof
In a disposable project with synthetic data only:
- connect from the candidate BFF runtime over the private endpoint;
- prove TLS encryption and CA verification;
- prove hostname verification (equivalent to `verify-full`);
- prove wrong CA, wrong hostname, expired certificate, public IP, and plaintext connections fail;
- inspect the actual Node.js `pg` behavior and current repository pool configuration;
- ensure no public DB URL is retrieved or used.

Failure of private networking or strict TLS verification is a no-go for this provider architecture. Do not fall back to a public database endpoint.

### Gate G3 — BFF ingress
- Confirm HTTPS at the external load balancer.
- Confirm Cloud Run accepts traffic only through the load-balancer ingress path.
- Confirm default `run.app` URL is disabled or blocked.
- Confirm direct-origin access cannot bypass edge policy.
- Confirm forwarded headers and secure cookies behave correctly.

### Gate G4 — Keycloak public/admin separation
- Prove required OIDC discovery, authorization, token, JWKS, and callback routes work.
- Prove admin console, Admin REST API, management port, and metrics are denied from the public path.
- Prove authorized operator access through the restricted admin path.
- Confirm exact issuer and redirect URI values.
- If route separation is not robust, stop and redesign; do not expose the admin interface.

### Gate G5 — Database operations
- Confirm automated backup schedule, retention, PITR availability, and export.
- Restore both databases into isolated disposable instances.
- Verify schema, data integrity, and operational recovery steps.
- Confirm migration principal and app role separation.

### Gate G6 — Secrets, monitoring, and cost
- Verify workload identity and least-privilege Secret Manager access.
- Verify no secrets appear in logs.
- Confirm alerts for outbox failures and service/database health.
- Prepare the full regional monthly cost estimate and budget alerts.

### Gate G7 — Security acceptance
- Run the staging-specific threat review.
- Validate recovery rate limiting and security notification before any external recovery exposure.
- Verify no production data, identity realm, credentials, or live integrations are present.
- Obtain a separate explicit owner approval for provider selection and provisioning.

## 8. Known application gaps to resolve in separately approved work

This design does not change application code. Current repository findings indicate:
- no health/readiness endpoints in the BFF route map;
- no built-in application rate limiter;
- current database TLS configuration needs a Cloud SQL-specific strict identity-verification proof;
- session encryption key has no documented versioned rotation support;
- recovery requires trusted-edge rate limiting and a security notification path before external exposure;
- operational dashboards, alerts, and runbooks are not yet integrated.

These gaps must not be silently treated as completed by creating cloud resources.

## 9. Open decisions

| Decision | State |
|---|---|
| Provider | Google Cloud is the leading candidate for validation; not selected |
| Region | Open |
| BFF runtime | Cloud Run proposed |
| Keycloak runtime | Compute Engine VM vs Cloud Run; open |
| Keycloak admin path | Must be separately designed and tested |
| INFINYX DB | Cloud SQL PostgreSQL, private only, proposed |
| Keycloak DB | Separate Cloud SQL PostgreSQL preferred |
| Private connection mode | PSC vs private services access; open pending runtime test |
| TLS mechanism | Direct strict TLS vs Cloud SQL connector; open pending `pg` compatibility proof |
| Session key rotation | Design required before rotation |
| Monthly budget | Not provided |
| Domain/DNS | Not selected |
| Backup retention | Open |
| Operations owner | Not assigned |

## 10. Explicit non-goals and approval boundary

This document does not authorize:
- creating or selecting a Google Cloud billing account or project;
- enabling APIs or changing organization policies;
- provisioning VPCs, subnets, firewall rules, Cloud Run, Compute Engine, Cloud SQL, load balancers, Cloud Armor, or Secret Manager;
- creating domains, DNS records, or certificates;
- creating or modifying Keycloak realms, clients, users, or secrets;
- generating, retrieving, or rotating real secrets;
- accessing or migrating production/staging data;
- changing application code, CI workflows, GitHub secrets, or repository settings;
- deployment, public exposure, merge, or release.

**Next proposed step:** a read-only implementation-level compatibility review of the current Node.js PostgreSQL pool and Cloud SQL strict TLS options, followed by a disposable proof-of-concept plan. Any code, cloud project, or resource creation requires separate explicit approval.
