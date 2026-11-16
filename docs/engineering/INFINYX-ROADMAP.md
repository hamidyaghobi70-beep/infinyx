# INFINYX — Product, Engineering, Security, and Release Roadmap

**Document status:** Working baseline  
**Date:** 2026-11-16  
**Repository:** hamidyaghobi70-beep/infinyx  
**Implementation branch:** feat/infinyx-public-site-shell

## 1. Mission and operating commitment

INFINYX is being developed as a trustworthy, extensible AI platform. The first demonstrable product slice is a public website plus an AI agent for small and medium-sized retailers. The agent is intended to support store operations, marketing, product and inventory workflows, customer/order workflows, and sales analysis.

Work should proceed end-to-end through implementation, verification, documentation, and release preparation. The work must not be abandoned halfway or handed off as a substitute for completing the agreed engineering tasks. Progress must be evidenced by repository changes, passing checks, reviewable artifacts, and explicit release-gate results—not by promises.

The assistant can implement and verify repository changes and prepare deployment/release assets. Actions requiring account ownership, paid services, domain registration, production credentials, legal acceptance, or final authorization must be surfaced to the owner for approval. No production release, merge to `main`, or public deployment is authorized by this roadmap alone.

## 2. Product scope and phases

### Phase A — Public website foundation
- Complete the public-site shell and responsive behavior across mobile, tablet, and desktop.
- Review navigation, content hierarchy, forms, loading/error/empty states, and accessibility.
- Verify metadata, canonical/robots behavior, sitemap/robots policy, favicon, and social preview metadata.
- Validate performance and avoid shipping unnecessary client-side code.
- Keep public marketing pages separate from authenticated application surfaces.

**Exit evidence:** responsive screenshots or review notes, automated checks, accessibility findings, metadata checks, and a successful production build.

### Phase B — Identity and account security
- Define user, organization/store, membership, role, and permission models before implementing protected workflows.
- Implement secure registration, email verification, login, logout, password reset, and session revocation.
- Use secure, HttpOnly, SameSite cookies; enforce TLS in production; protect state-changing requests against CSRF where applicable.
- Hash passwords with a modern password-hashing algorithm and calibrated parameters; never store plaintext passwords.
- Add rate limits and abuse controls for authentication and recovery endpoints.
- Plan MFA, recovery codes, and administrator protections.
- Keep secrets out of source control and logs; use managed secrets in deployed environments.

**Exit evidence:** automated authentication tests, session lifecycle tests, recovery-flow tests, rate-limit tests, and security review.

### Phase C — Authorization and tenant isolation
- Enforce authorization on the server for every protected operation; hiding UI controls is not authorization.
- Apply deny-by-default permissions and least privilege.
- Ensure every store-owned record is scoped to the authenticated tenant on every read and write.
- Prevent insecure direct-object references and cross-tenant data access.
- Add tests proving one tenant cannot read, alter, enumerate, or infer another tenant's data.
- Separate platform-operator privileges from store-owner and staff privileges.

**Exit evidence:** role/permission matrix, negative authorization tests, cross-tenant isolation tests, and reviewed data-access patterns.

### Phase D — INFINYX AI agent
Build one extensible agent runtime with specialist capabilities rather than unrelated bots:
1. Store assistant and workflow coordinator.
2. Marketing and campaign drafting.
3. Product catalog and inventory assistance.
4. Order and customer-support assistance.
5. Sales analytics and recommendations.

Agent safety requirements:
- The model must not receive unrestricted database or infrastructure access.
- Tools must be explicitly registered, narrowly scoped, authenticated, authorized, validated, and audited.
- Treat user content, retrieved documents, and external tool output as untrusted data; defend against prompt injection.
- Require explicit human approval for consequential actions such as publishing campaigns, changing prices, issuing refunds, or sending customer messages.
- Apply tenant scoping to memory, retrieval, logs, and tool execution.
- Add budgets, timeouts, retries, idempotency, and safe failure behavior.
- Provide traceable explanations of actions and a way to cancel or revoke pending operations.

**Exit evidence:** agent tool-permission tests, prompt-injection and abuse scenarios, approval-flow tests, tenant-isolation tests, and end-to-end retail scenarios.

### Phase E — Data, operations, and resilience
- Select and document persistence, backup, restore, queue, and job-processing architecture before relying on durable workflows.
- Define data retention, deletion, export, and privacy handling.
- Add structured observability with sensitive-data redaction, health/readiness checks, metrics, alerting, and operational dashboards.
- Define incident response, vulnerability handling, dependency updates, and backup restoration exercises.
- Separate development, preview/staging, and production environments with distinct credentials and data.

**Exit evidence:** restore test, operational runbook, alert checks, environment separation review, and documented incident process.

### Phase F — Independent review and release
- Run CI on the actual product branch and on pull requests targeting it.
- Run type checks, build, unit/API/integration tests, process tests, dependency/security audits, and static analysis.
- Conduct accessibility, browser, responsive, and performance reviews.
- Obtain an independent security review; record findings and verify fixes. Do not claim a third-party audit unless evidence is supplied.
- Resolve all critical/high findings or document an explicitly approved mitigation.
- Prepare release notes, deployment instructions, rollback plan, support/contact path, privacy policy, terms, and service limitations.
- Deploy first to staging; run smoke and acceptance tests; then request explicit production-release authorization.

**Exit evidence:** green CI run(s), test reports, audit report and remediation record, staging acceptance, rollback proof, and written release approval.

## 3. Security baseline

Security is a foundational design constraint, not a final polish task. The baseline includes:
- Authentication (who the user is) and authorization (what the user may do) as separate controls.
- Server-side, deny-by-default authorization.
- Tenant isolation enforced at data-access boundaries.
- Secure session management and account recovery.
- Input validation, output encoding, safe error handling, and request-size limits.
- CSRF, XSS, injection, SSRF, and access-control defenses appropriate to each interface.
- Content Security Policy and other security headers, reviewed against actual application needs.
- Secret management, encryption in transit, and appropriate encryption at rest.
- Redacted logs, security audit events, dependency scanning, and vulnerability response.
- Human approval for high-impact agent actions.
- Backups, restore tests, retention, and deletion procedures.

Existing security headers or logger redaction are useful controls but do not establish that the whole platform is secure.

## 4. Known constraints and truthful status

Prior repository review found a useful public-site/API foundation, security headers, logging redaction, and automated tests. The reviewed release documentation also states that the current private-alpha runtime does not yet provide production-grade authentication/authorization, tenant isolation, durable persistence/queues, abuse controls, durable audit, full monitoring, production secrets management, or incident response.

Therefore:
- Do not describe the current platform as production-ready or safe for sensitive/public customer data until the relevant controls are implemented and verified.
- Historical test or audit results must not be represented as current results.
- A CI configuration change is not proof that CI has run successfully.
- An independent review is pending until a real report is available.

## 5. Engineering workflow and quality bar

For each task:
1. Inspect the current branch and relevant code before editing.
2. State the intended change and acceptance criteria in the issue/commit or engineering note.
3. Make the smallest coherent change; avoid unrelated rewrites.
4. Add or update automated tests with the implementation.
5. Run the relevant checks and record exact outcomes.
6. Review the diff for security, compatibility, accessibility, and regressions.
7. Update documentation and the status ledger.
8. Do not claim completion until the result has been fetched or otherwise independently verified.

Prefer maintainable, boring, well-supported technology over novelty. Record trade-offs and unresolved risks. Never fabricate test results, audit findings, deployment status, or external approvals.

## 6. Release authorization and ownership boundaries

The engineering objective is to carry the work through implementation and release readiness rather than stop at a plan. However, the following remain owner-controlled:
- Purchasing or configuring paid services.
- Domain registration and DNS changes.
- Providing or authorizing production credentials.
- Accepting legal terms or making legal/privacy representations.
- Merging to `main` where approval is required.
- Publishing or deploying to production.

The assistant may prepare and verify everything possible before these gates, then request only the specific approval or access required. No approval is inferred from silence.

## 7. Immediate execution order

1. Verify and correct the CI triggers for `feat/infinyx-public-site-shell`; then verify the committed file and an actual workflow run.
2. Review the complete public-site implementation and establish a baseline for responsive design, accessibility, performance, metadata, and tests.
3. Create a prioritized issue/backlog from verified findings.
4. Document the agent architecture, identity model, permission model, tenant boundaries, and data model before implementing protected agent tools.
5. Implement in vertical slices, with tests and documentation at each step.
6. Prepare staging and release artifacts only after the relevant security and quality gates pass.

## 8. Status ledger

Update this section with dated, verifiable evidence as work proceeds.

| Workstream | Status at baseline | Required proof to mark complete |
|---|---|---|
| Public-site shell | Existing implementation; full review pending | Responsive, accessibility, browser, and build/test evidence |
| CI branch triggers | Needs verification and correction | Fetched committed workflow plus successful run |
| Authentication | Not production-ready per prior release documentation | End-to-end auth/session/recovery tests and review |
| Authorization | Not production-ready per prior release documentation | Permission matrix and server-side negative tests |
| Tenant isolation | Not production-ready per prior release documentation | Cross-tenant isolation tests |
| Agent runtime | Architecture and implementation to be completed | Tool-safety, approval, tenant, and scenario tests |
| Persistence/operations | Production capabilities incomplete per prior documentation | Backup/restore, monitoring, runbooks, and environment evidence |
| Independent security review | Pending | Actual review report and verified remediation |
| Production release | Not authorized | Staging acceptance and explicit owner approval |

---
This roadmap is the governing engineering baseline for the current INFINYX effort. Any proposed deviation must be documented with its reason, risks, impact on security/release criteria, and approval before changing direction.
