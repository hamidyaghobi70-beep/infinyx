# INFINYX Staging Deployment Decision Record (DDR)

- **Status:** Proposed; no provider selected
- **Date:** 2026-11-27
- **Repository:** `hamidyaghobi70-beep/infinyx`
- **Branch:** `feat/adr-platform-foundation`
- **Related design:** `docs/engineering/staging-deployment-architecture-design.md`
- **Decision owner:** INFINYX founder
- **Approval boundary:** Comparison and recommendation only. No account creation, subscription, purchase, provisioning, DNS, secrets, configuration, deployment, merge, or release is authorized.

## 1. Decision to be made

Select a hosting pattern for a small, isolated, persistent staging environment for:

- INFINYX Web BFF (Node.js HTTP behind trusted HTTPS ingress);
- Keycloak (dedicated staging realm and confidential client);
- PostgreSQL for INFINYX;
- separate PostgreSQL database/service for Keycloak;
- backups, logs, metrics, and controlled administrative access.

The staging environment must use synthetic identities/data and must not connect to production credentials, databases, or live messaging/payment/social integrations.

## 2. Non-negotiable requirements

1. BFF is not directly public; only trusted HTTPS ingress can reach its private listener.
2. PostgreSQL is private, TLS-validated, and not publicly exposed.
3. Keycloak user-facing OIDC endpoints use HTTPS; administrative interfaces are restricted.
4. Keycloak and INFINYX data stores are logically and credential-wise separated; separate managed clusters are preferred where affordable.
5. Durable storage, backups, and a tested restore process are mandatory before external testing.
6. Secret values are injected from a secret manager/workload identity and never committed or printed.
7. Staging uses synthetic data only.
8. No scale-out until session revocation workers and concurrency behavior are validated across instances.
9. Recovery remains unavailable to external users until edge rate limiting and a reviewed security-notification path exist.
10. No provider choice may weaken TLS verification, redirect allow-lists, tenant isolation, or least-privilege DB grants.

## 3. Shortlisted hosting patterns

### Option A — Render managed application + managed PostgreSQL

**Shape**
- BFF and Keycloak as separate paid services; Keycloak custom container.
- HTTPS provided by the platform for web services; use a private service path for BFF origin.
- Separate paid PostgreSQL services for INFINYX and Keycloak, or explicitly documented separate databases/roles if a single cluster is considered later.
- Restrict Keycloak admin paths using a separately reviewed access boundary; do not assume that a private service alone solves the public OIDC/admin split.

**Strengths**
- Low infrastructure administration burden.
- Native service deployment from repository/container and managed PostgreSQL.
- Paid PostgreSQL includes managed capabilities such as backups/PITR according to plan.
- Published compute and database price tiers make a first estimate possible.

**Weaknesses / risks**
- Free services are not acceptable for persistent staging: free Postgres expires after 30 days, has no backups, and free web services have ephemeral local filesystems and spin down.
- Keycloak admin restriction and exact network topology need validation before selecting this option.
- Two separate database services plus a suitably sized Keycloak service can make the monthly cost materially higher than the headline minimum.
- Workspace tier features and service compute are separate billing dimensions.

**Indicative published prices (USD/month, before tax/overages)**
- BFF service: from $7 for a 512 MB service; suitability must be load-tested.
- Keycloak service: $25 for a 1 CPU / 2 GB service as an initial sizing placeholder, not a guarantee of sufficiency.
- Managed PostgreSQL: $19 for 1 GB; storage is additional.
- Two separate 1 GB PostgreSQL services plus the example compute sizes imply roughly $70/month before storage, bandwidth, tax, and optional workspace costs. This is an illustrative configuration, not a quote.

Official references:
- https://render.com/pricing
- https://render.com/docs/free
- https://render.com/docs/service-types

### Option B — Railway managed platform services + persistent volumes

**Shape**
- BFF and Keycloak as separate services/containers.
- PostgreSQL services with persistent volumes, subject to confirming the current supported database/backup model and operational responsibilities.
- Place all services in one selected region; moving a service with attached volume requires volume migration and downtime.

**Strengths**
- Low entry-level plan minimum and usage-based billing.
- Simple multi-service deployment and persistent volumes.
- Region can be selected; service volumes follow the service region.

**Weaknesses / risks**
- Usage-based pricing makes the total less predictable without a measured resource profile and spend alerts.
- A persistent volume is not equivalent to a managed database backup/restore service.
- Hobby plan volume allowance is limited; verify actual database storage, backups, and restore procedure.
- Platform documentation notes that data remains in the selected region while Railway's own processing primarily occurs in the United States; review contractual data-transfer terms before storing sensitive data.
- Region migration of a volume causes downtime.

**Indicative published prices**
- Hobby plan: $5 monthly minimum usage, credited against usage.
- Hobby volume allowance: 5 GB; free/trial allowance is smaller.
- Actual service CPU, RAM, storage, and egress usage are additional billing inputs; do not treat $5 as the total monthly staging cost.

Official references:
- https://railway.com/pricing
- https://docs.railway.com/pricing
- https://docs.railway.com/volumes/reference
- https://docs.railway.com/deployments/regions
- https://docs.railway.com/enterprise/security

### Option C — Hetzner Cloud VM(s) + separately managed PostgreSQL

**Shape**
- One or more Linux VMs run BFF and Keycloak containers behind a maintained reverse proxy.
- PostgreSQL is preferably a separate managed service; if self-hosted, it must have independent backup storage and a tested recovery process.
- Network firewall rules, OS patching, TLS, container updates, monitoring, and restore operations are owned by the project/operator.

**Strengths**
- Low compute entry price, especially in European locations.
- Full control over network topology, Keycloak admin access, and container runtime.
- Can keep BFF and Keycloak on private interfaces with explicit firewall rules.
- Suitable when an operator is prepared to own system administration.

**Weaknesses / risks**
- More operational responsibility: host hardening, patching, firewall, reverse proxy, backups, alerting, incident response, and restore testing.
- A single VM is a single failure domain; it is not high availability.
- Self-managed PostgreSQL increases the risk of backup/restore mistakes and consumes operational time.
- Published VM price excludes or may not include all IPv4, storage, backup, traffic, tax, and managed database costs.

**Indicative published prices**
- Hetzner's June 2026 price adjustment lists European examples such as CX23 at $6.49/month and CAX21 at $12.49/month, excluding VAT as stated in the pricing notice. These are VM prices only, not a complete staging cost.
- European locations include Germany and Finland; location availability varies by product.

Official references:
- https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/
- https://docs.hetzner.com/cloud/general/locations/

### Option D — Fly.io Machines + Managed PostgreSQL

**Shape**
- Separate Machines for BFF and Keycloak, with persistent volumes where required.
- Fly Managed Postgres for the application database, and a separate managed cluster/database for Keycloak after confirming supported topology and backup policy.

**Strengths**
- Fine-grained compute billing and regional placement.
- Separate Machines can isolate BFF and Keycloak.
- Managed Postgres includes high availability, automated backups, and connection pooling according to current published plan details.

**Weaknesses / risks**
- Managed PostgreSQL is significantly more expensive than the smallest compute instances.
- Network, volume, and operational configuration requires more platform familiarity than a highly managed PaaS.
- Need to confirm exact private networking and admin ingress controls before adoption.

**Indicative published prices**
- A 2 GB performance-1x Machine is listed at about $33/month; a 4 GB performance-2x at about $66/month.
- Managed Postgres Basic is listed at $38/month, with storage billed separately.
- A two-Machine topology plus a managed database therefore starts above $100/month before a second DB, storage, and egress. Actual regional pricing may vary.

Official references:
- https://fly.io/pricing/
- https://fly.io/pricing-update/
- https://fly.io/docs/about/pricing/

## 4. Managed database reference point

DigitalOcean Managed PostgreSQL is a useful price/operations benchmark even if its application compute is hosted elsewhere:

- Single-node clusters start at $15/month for 1 GiB RAM; documentation recommends these for preliminary development/testing and notes they are not highly available.
- HA clusters start at $30/month for a 2 GiB primary node, with at least one matching $30/month standby.
- Exact storage and region pricing must be checked at selection time.

Official references:
- https://docs.digitalocean.com/products/databases/postgresql/details/pricing/
- https://www.digitalocean.com/pricing/managed-databases

## 5. Comparative assessment

| Criterion | Render | Railway | Hetzner VM | Fly.io |
|---|---|---|---|---|
| Ease of first deployment | High | High | Medium/low | Medium |
| Operational burden | Low/medium | Low/medium | High | Medium |
| Cost predictability | Relatively high | Usage-sensitive | VM predictable; ops cost hidden | Usage and topology sensitive |
| Managed PostgreSQL path | Yes | Verify service model and backups | External provider or self-managed | Yes |
| Fine-grained network control | Platform-dependent | Platform-dependent | High | High |
| Admin-path isolation | Must validate | Must validate | Explicitly configurable | Must validate |
| Backups/restore responsibility | Lower with paid DB; still test | Must verify per DB/volume | Operator-owned unless managed DB | Managed DB features; still test |
| Best fit | Low-ops staging | Fast iteration | Lowest infrastructure cost with skilled ops | Flexible isolated services |

## 6. Preliminary recommendation

**Preferred direction for further validation: Option A (Render), conditional on proving Keycloak administrative isolation and confirming a complete monthly estimate.**

Reasons:
- INFINYX needs persistent PostgreSQL and a real OIDC provider; a free ephemeral setup is not sufficient.
- A managed platform reduces the operational burden while the application is still in the staging-validation phase.
- Published pricing is comparatively easy to estimate.
- It avoids immediately taking on Linux host, database backup, patching, and reverse-proxy administration.

**Fallback:** Option C (Hetzner VM plus managed PostgreSQL) only if a responsible operator is explicitly assigned to host hardening, updates, network policy, backups, and incident response. Low VM pricing alone is not enough to justify self-hosting identity infrastructure without that operational ownership.

**Not recommended as the first persistent staging target:** free Render tiers or a Railway free/trial configuration. They are useful for previews, not as the durable identity/session environment described in the staging architecture.

This is a recommendation for the next design validation step, not an approved vendor selection.

## 7. Cost-control guardrails

Before any provider is selected:
- Set a monthly budget ceiling and an alert threshold below that ceiling.
- Include app compute, Keycloak compute, two data stores, storage, backups, egress, IPv4, logs/metrics, taxes, and support/workspace plan costs.
- Define who can change plans or create resources.
- Enable spend notifications and hard limits where available; do not assume every provider offers a strict hard cap.
- Confirm billing currency, VAT, payment requirements, cancellation, and data export/deletion terms.
- Never store payment credentials or account secrets in the repository or this record.

No exact total is approved in this DDR because final sizing, region, database topology, retention, and tax treatment have not been selected.

## 8. Required validation before selecting a provider

1. Obtain a current quote for the exact region and service sizes.
2. Confirm the provider supports the required Keycloak container and persistent database topology.
3. Verify public authorization endpoints can be exposed while administrative endpoints remain restricted.
4. Verify private BFF-to-PostgreSQL and BFF-to-Keycloak network paths.
5. Confirm PostgreSQL TLS CA trust is compatible with the current Node.js pool configuration.
6. Confirm automated backups, retention, point-in-time recovery, export, and restore procedure for both databases.
7. Confirm secret manager/workload identity and emergency rotation support.
8. Confirm region/data-residency and data-processing terms.
9. Validate ingress forwarding-header trust, cookie behavior, callback URLs, and rate limiting.
10. Recalculate total monthly cost including taxes and storage.

## 9. Open decisions

| Decision | Current state |
|---|---|
| Hosting provider | Not selected |
| Region | Not selected |
| Staging domain | Not selected |
| Monthly budget ceiling | Not provided |
| BFF and Keycloak service sizing | Not load-tested |
| Database topology | Separate services preferred; exact choice open |
| Secret manager | Not selected |
| Backup retention | Not selected |
| Operator/incident owner | Not assigned |
| Recovery rate-limit and notification policy | Still a blocker before external exposure |

## 10. Explicit approval gates

This DDR authorizes no account creation, trial activation, payment, resource provisioning, DNS/certificate issuance, database creation, Keycloak configuration, secret generation, code or CI changes, deployment, public exposure, merge, or release.

Next step: review this comparison and choose whether to (a) request a detailed Render validation plan, (b) request a Hetzner + managed PostgreSQL plan, or (c) provide a budget/region constraint for a revised comparison. Provider selection and all provisioning actions require explicit approval.
