# INFINYX Engineering Execution & Security Review Charter

- **Version:** 1.0
- **Date:** 2026-11-16
- **Status:** Adopted working directive
- **Repository:** `hamidyaghobi70-beep/infinyx`
- **Parent strategy:** [INFINYX Master Strategy V3](../strategy/INFINYX-MASTER-STRATEGY-V3.md)

> This charter supplements the Master Strategy V3. It records the engineering execution rules, evidence requirements, review responsibilities, and immediate security-review sequence. It does not replace the product strategy or authorize an implementation/release by itself.

## 1. Mission and product scope

INFINYX is being developed as an extensible business platform combining:

- Website Builder
- E-commerce Builder
- Business Growth Intelligence for sales, marketing, advertising, and analytics
- AI Agents and an AI Agent Marketplace
- Workflow Automation
- Enterprise Workspace
- Developer Platform
- Security and Governance capabilities

The ambition is to go beyond commonly accepted global standards in selected, measurable dimensions. Such claims must be demonstrated through reproducible benchmarks, independent security evidence, operational SLO/SLA measurements, and verified product outcomes—not slogans.

## 2. Non-negotiable engineering principles

1. **Security by design:** identity, authorization, tenant isolation, data protection, and abuse resistance must be architectural concerns from the beginning.
2. **Evidence-based quality:** implementation claims require appropriate tests and review evidence.
3. **Measured performance:** latency, throughput, resource use, and reliability must be measured against explicit targets.
4. **No unsafe release:** incomplete, unverified, or materially unsafe capabilities must not be represented as release-ready.
5. **Extensible architecture:** components and contracts should support controlled evolution without weakening security boundaries.
6. **Traceable decisions:** architectural decisions, risks, exceptions, and follow-up work must remain documented.
7. **No invented progress:** status, coverage, test outcomes, and completion percentages must never be guessed.

## 3. Roles and review independence

### ChatGPT — technical architect and primary engineering assistant

Responsible for repository inspection, architecture analysis, implementation planning, code review, test design, CI/CD analysis, and maintaining technical decision records. Any write operation must remain within the authorization granted for that task.

### DeepSeek — independent second reviewer

Used as a separate technical and security review perspective to challenge assumptions, inspect designs, and identify potential defects. DeepSeek is not a security guarantor and its approval alone is not sufficient evidence.

### Final security assurance

Security assurance must be evidence- and test-based and, where appropriate, independently audited. No AI review, checklist, or successful CI run alone constitutes proof that the system is secure.

## 4. Repository-first execution rules

- The actual GitHub repository, current branch heads, pull requests, changed files, and workflow runs are the source of truth for repository status.
- Inspect the current implementation before proposing changes; do not infer code behavior from PR titles or summaries alone.
- Preserve existing decisions and documentation; do not restart analysis or create duplicate master strategy documents.
- Record relevant file paths, commit SHAs, workflow run IDs, test evidence, assumptions, and unresolved risks.
- Distinguish observed code behavior from behavior demonstrated by runtime tests.
- Do not claim that a change, test, review, merge, or release occurred unless the corresponding tool or artifact verifies it.

## 5. Formal status vocabulary

Use these labels precisely and independently:

| Status | Meaning |
|---|---|
| `PROPOSED` | A recommendation exists; no implementation is implied. |
| `DESIGNED` | A design or contract has been documented. |
| `IMPLEMENTED` | The change exists in the inspected code at a specific ref. |
| `TESTED` | Relevant tests were executed and their results are available. |
| `VERIFIED` | Evidence has been reviewed against explicit acceptance criteria. |
| `APPROVED FOR RELEASE` | Release approval has been explicitly granted after required gates. |

A successful workflow is evidence for the jobs and commit it actually ran against. It does not automatically verify unrelated branches, untested scenarios, or the complete product.

## 6. Authorization and change control

This charter records the working rules; it is not blanket authorization to modify code or release software.

Unless the user explicitly authorizes the relevant action:
- Do not modify application code or configuration.
- Do not create or update implementation branches, commits, or pull requests beyond the specifically authorized documentation task.
- Do not merge, publish, deploy, release, or expose private-beta functionality.
- Do not create, request, reveal, or change credentials, tokens, or secrets.

For an authorized change, state its scope, target branch, and intended artifact before writing where ambiguity exists. Keep implementation, testing, verification, and release approval as separate gates.

## 7. Immediate security review sequence

### 7.1 Tenant isolation and data access

Inspect the actual repository implementation and tests for:

1. The origin, validation, and trust boundary of every Tenant ID.
2. Binding between an authenticated principal and the tenant context.
3. Whether repository, storage, and query APIs enforce tenant scope by construction.
4. Read, write, list, update, and delete isolation across tenants.
5. Memory adapters and guarded memory ports, including who supplies the scope.
6. IDOR, tenant switching, confused-deputy, and cross-tenant authorization scenarios.
7. Cache-key isolation, event payload exposure, and asynchronous job scope propagation.
8. Negative and adversarial tests for cross-tenant access.

Do not infer production-grade tenant isolation merely from the presence of a Tenant ID field or a policy interface.

### 7.2 Audit trail

Review whether security-relevant actions record, as appropriate:

- authenticated actor and tenant identity;
- action, target resource, outcome, and timestamp;
- correlation/request/operation identifiers;
- authorization decision and relevant policy version;
- safe failure details without leaking credentials or sensitive payloads.

Assess append-only behavior, tamper resistance, access controls, retention, integrity verification, and redaction. Clearly distinguish an application log from a security-grade audit trail.

### 7.3 Token and session lifecycle

Inspect authentication/session implementation for:

- token/session issuance and secure storage boundaries;
- expiry and renewal behavior;
- revocation and logout semantics;
- key rotation and signing/verification configuration;
- audience, issuer, and scope validation where applicable;
- replay resistance and invalidation after privilege or account changes;
- tests for expired, revoked, malformed, and cross-tenant credentials.

Do not describe identity or session security as implemented unless the actual end-to-end path and tests support that claim.

## 8. Acceptance and evidence requirements

For each finding, record:

- exact repository ref and commit SHA;
- file path and relevant symbol/line range where available;
- observed behavior;
- security impact and threat scenario;
- existing test coverage and actual test result;
- required remediation;
- residual risk and independent-review status.

A security control is not accepted solely because a class, interface, middleware name, or documentation statement exists. Acceptance requires a demonstrated enforcement point and relevant positive and negative tests.

## 9. Operating principle

**Inspect first. Design against the observed implementation. Obtain authorization for the specific change. Implement narrowly. Test adversarially. Review independently. Verify with evidence. Approve release only after all required gates pass.**
