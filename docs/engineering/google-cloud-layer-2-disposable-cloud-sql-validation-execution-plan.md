# Google Cloud Layer 2 — Disposable Private Cloud SQL Validation Execution Plan

- **Status:** Execution plan only; awaiting a separate provisioning approval
- **Branch:** `feat/adr-platform-foundation`
- **Related architecture:** `docs/engineering/google-cloud-staging-architecture-design.md`
- **Related test plan:** `docs/engineering/postgres-cloud-sql-strict-tls-validation-plan.md`
- **Related local implementation:** `docs/engineering/postgres-strict-tls-local-validation-implementation.md`

## 1. Purpose and strict boundary

Layer 1 has already validated the application's local TLS behavior. Layer 2 is intended to prove that the exact PostgreSQL client configuration can connect to a real, disposable Cloud SQL for PostgreSQL instance over a private network while verifying both the certificate chain and the server DNS identity.

This document is a plan only. It does **not** authorize or perform:
- creating/selecting a Google Cloud project;
- enabling APIs or billing;
- creating VPCs, subnets, Cloud SQL instances, service identities, IAM bindings, secrets, or DNS records;
- running cloud tests or connecting to any existing database;
- changing application code, CI, staging, production, DNS, Keycloak, or network policy;
- deployment, merge, or release.

A separate explicit approval is required before any cloud resource or charge is created.

## 2. Non-negotiable security requirements

1. Cloud SQL must have **no public IPv4 address**. Public IP must remain disabled throughout the test.
2. The BFF test workload must reach the database through a private VPC path in the same selected region.
3. No external/public database URL may be retrieved, configured, or used. There is no public fallback.
4. TLS must be enabled and must validate the trusted CA chain and the expected DNS identity.
5. `rejectUnauthorized: false`, plaintext connections, unverified `sslmode=require`, and IP-only identity checks are prohibited.
6. Use only synthetic database records and a dedicated least-privilege test principal.
7. Do not use any existing staging or production project, database, credential, or customer data.
8. Stop immediately if private DNS, certificate identity, or private routing cannot be proven. Do not weaken the requirements to make the test pass.

## 3. Proposed disposable topology

The test should be limited to one region and the smallest practical isolated footprint:

- **Dedicated test project:** created specifically for this proof, with billing visibility and no unrelated workloads.
- **VPC:** one dedicated VPC and only the required subnet/routing resources.
- **Cloud SQL for PostgreSQL:** one temporary instance, private IP only, public IP disabled, automated backups/PITR not enabled unless required by the test and explicitly costed.
- **BFF test workload:** a short-lived Cloud Run revision/job or equivalent isolated workload with private VPC egress. Prefer Cloud Run Direct VPC egress if it satisfies the chosen topology and avoids a continuously billed connector. If a Serverless VPC Access connector is required, its minimum instance and hourly charges must be included before approval.
- **Private DNS:** the database connection hostname must resolve to the private endpoint and match the DNS identity in the server certificate.
- **Secrets:** synthetic database password and test CA material supplied only through a managed secret mechanism or short-lived protected runtime configuration; never commit them or print them in logs.

The exact region, Cloud SQL CA mode, private DNS name, and VPC egress mechanism remain undecided. No region is inferred or selected in this plan.

## 4. Candidate connection modes

### A. Direct `pg` TLS

Use the Layer 1 configuration contract:
- `DATABASE_URL` without any SSL-related query parameters;
- `DATABASE_SSL=require`;
- `DATABASE_SSL_CA` containing the trusted PEM CA;
- `DATABASE_SSL_SERVERNAME` set to the DNS identity present in the server certificate SAN.

Before cloud execution, confirm the selected Cloud SQL CA mode actually issues a certificate compatible with the intended private DNS identity. A private IP alone is not a valid substitute for DNS identity verification.

### B. Cloud SQL Connector

This is an alternative, not an assumed requirement. It may reduce manual CA distribution, but must independently prove:
- private-IP-only selection;
- server/client identity verification;
- least-privilege IAM;
- no public endpoint fallback;
- correct pool, retry, shutdown, and connector lifecycle behavior.

Adding a connector dependency or changing the application to use it requires separate code-change approval. Layer 2 must not silently switch methods during execution.

## 5. Test sequence

### Gate 0 — Pre-provisioning review

Before creating anything:
- select the project owner and region;
- confirm billing account and payment authorization;
- calculate a region-specific estimate in Google Cloud Pricing Calculator;
- list every resource and its expected lifetime;
- define a maximum test duration and named operator responsible for teardown;
- verify that public IP is disabled in the proposed Cloud SQL configuration;
- verify that the intended CA mode and private DNS name support hostname validation;
- agree on a spend-alert threshold and a separate teardown deadline.

If any item is unknown, stop before provisioning.

### Gate 1 — Create isolated resources

Only after explicit approval:
1. Create/use the dedicated test project.
2. Enable only the APIs required for Cloud SQL, networking, workload execution, secrets, and logging.
3. Create the minimal VPC and private service connectivity required by the selected Cloud SQL private-IP model.
4. Create the temporary Cloud SQL instance with public IP disabled.
5. Create one synthetic database and a dedicated least-privilege test user.
6. Configure private DNS and the selected certificate identity.
7. Configure the BFF test workload with private egress and narrowly scoped identity.
8. Verify the Cloud SQL instance reports no public IP before attempting a connection.

### Gate 2 — Execute mandatory positive and negative tests

| ID | Test | Expected result |
|---|---|---|
| G01 | Resolve configured database hostname from BFF workload | Resolves only to the private endpoint |
| G02 | Inspect Cloud SQL network configuration | Public IP disabled; private IP present |
| G03 | Connect using correct CA and DNS SAN | Connection succeeds |
| G04 | Connect with wrong CA | TLS handshake fails |
| G05 | Connect with wrong server name | TLS hostname verification fails |
| G06 | Attempt plaintext | Connection fails |
| G07 | Supply SSL query parameters in URL | Application rejects configuration before connecting |
| G08 | Remove/deny database permission | Connection or query fails without privilege escalation |
| G09 | Temporarily interrupt private path | Safe failure and bounded retry; no public fallback |
| G10 | Stop workload | Pool and any connector resources close cleanly |
| G11 | Review logs | No password, full URL, token, private key, or secret material appears |
| G12 | Inspect endpoint inventory | No public database endpoint or authorized public network exists |

Where a negative TLS case cannot safely be induced against Cloud SQL (for example an expired provider certificate), retain the passing local deterministic TLS fixture evidence from Layer 1 instead of changing a live managed certificate.

### Gate 3 — Evidence and teardown

Retain only redacted evidence:
- commit SHA and lockfile hash;
- Node.js and `pg` versions;
- region and resource configuration summary;
- proof that public IP is disabled;
- private DNS resolution and routing evidence;
- test IDs and outcomes;
- redacted TLS verification result;
- IAM permission summary;
- log-scrubbing review;
- resource deletion confirmation and final billing estimate.

Then:
1. Stop the test workload.
2. Delete the Cloud SQL instance and all test data.
3. Remove temporary secrets, service accounts/bindings, DNS records, VPC resources, and enabled APIs if they were created solely for the test and are safe to remove.
4. Confirm no persistent disks, snapshots, backups, logs with sensitive content, static IPs, connectors, or other billable resources remain.
5. Recheck the project resource inventory and billing report after usage data has settled.

Deletion must be verified; merely stopping a workload does not stop Cloud SQL instance charges.

## 6. Cost model and proposed guardrails

Google Cloud prices vary by region, edition, machine shape, storage, backup usage, networking, and billing configuration. The following are **reference figures, not a quote**:

- The Cloud SQL pricing page currently lists shared-core `db-f1-micro` at about **$0.0105/hour** in the displayed reference region (about **$0.25 for 24 hours** of instance runtime); shared-core shapes are not covered by the Cloud SQL SLA.
- SSD storage is listed at about **$0.000232877 per GiB-hour** in the displayed reference region (about **$0.17 per GiB for 30 days**).
- Used backup storage is listed separately at about **$0.000109589 per GiB-hour**.
- Cloud Run, VPC egress, Serverless VPC Access connectors (if used), logs, DNS, private connectivity, and other resources can add charges. Connector charges can materially exceed a tiny database's compute cost if left running.
- Prices must be recalculated for the selected region and exact topology immediately before approval.

**Proposed planning guardrails (not yet configured):**
- Target test window: no more than 4 hours after all resources are ready.
- Proposed spend-alert thresholds: 50%, 80%, and 100% of a separately approved test budget.
- Proposed maximum authorization to consider: **USD $30 total** for the disposable proof, excluding taxes or currency conversion. This is a proposed ceiling for owner review, not an assertion that the topology will fit it.
- If the exact estimate exceeds the approved ceiling, do not provision; return with a revised estimate.
- Cloud Billing budget alerts are notifications, **not a hard spending cap**. They do not automatically stop resources. Actual cost control depends on minimal resource scope, a short test window, and verified teardown.
- No commitment, reservation, paid support plan, or long-term resource should be created for this test.

If the chosen private egress path or required Cloud SQL shape cannot fit the approved budget, stop and present alternatives. Do not enable public IP or weaken TLS to reduce cost.

## 7. Acceptance and no-go criteria

**Pass** only if all of the following are true:
- private-only endpoint is demonstrated;
- no public IP or external database URL is used;
- trusted CA and hostname verification both succeed;
- wrong CA, wrong hostname, plaintext, and SSL-URL override tests fail closed;
- no public fallback occurs during network failure;
- IAM is least-privilege;
- logs contain no secrets;
- all resources are deleted and teardown is verified.

**No-go** if:
- private DNS cannot be made to match a supported certificate identity;
- the selected CA mode cannot meet strict identity verification;
- Cloud Run private egress requires an unbudgeted always-on connector;
- public connectivity is needed at any point;
- the estimate exceeds the approved ceiling;
- cleanup cannot be verified.

A no-go result means redesign or compare another private-network architecture; it does not permit a TLS downgrade.

## 8. Required owner decisions before provisioning

The following must be explicitly confirmed in a later approval:
1. Dedicated Google Cloud project and billing account to use.
2. Region.
3. Direct `pg` TLS or Cloud SQL Connector for this proof.
4. Exact budget ceiling and test window.
5. Approval to create and later delete the listed disposable resources.
6. Named person responsible for billing review and teardown verification.

## 9. Sources

Official pricing and technical references (recheck immediately before provisioning):
- [Cloud SQL pricing](https://cloud.google.com/sql/pricing)
- [Cloud Run pricing](https://cloud.google.com/run/pricing)
- [VPC network pricing / Cloud NAT](https://cloud.google.com/vpc/network-pricing)
- [Cloud Run VPC connectors](https://docs.cloud.google.com/run/docs/configuring/vpc-connectors)
- [Cloud SQL machine series](https://docs.cloud.google.com/sql/docs/postgres/machine-series-overview)

## 10. Approval boundary

This execution plan is documentation only. It does not create resources, enable billing or APIs, access secrets, run tests, or connect to a database. Layer 2 provisioning and cloud execution require a new, explicit approval after the owner has reviewed the exact project, region, topology, price estimate, budget, duration, and teardown steps.
