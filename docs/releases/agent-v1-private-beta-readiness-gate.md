# INFINYX Agent V1 — Private Beta Readiness Gate

**Assessment date:** 2026-11-16  
**Candidate baseline:** `integration/infinyx-agent-v1-audit-hardening`  
**Baseline SHA reviewed:** `f6f201ceeaa9511fbaab31e9a9999d5ed6308af8`  
**Disposition:** **NOT READY — engineering and security acceptance remain incomplete.**  
**Target:** a tightly controlled, non-production Private Beta after a separately assembled and accepted candidate.

## 1. Purpose and release boundary

This document defines the evidence required before the first INFINYX Agent V1 can be offered to a small, explicitly selected group of beta testers.

A Private Beta is not a production launch, security certification, or permission to expose the current runtime to the public internet. Until every applicable gate is closed:

- Do not publish, tag, distribute, deploy, or activate a release candidate.
- Do not expose the runtime to the public internet.
- Do not process real customer data, secrets, credentials, financial activity, or other sensitive workloads.
- Keep external tool execution, privileged operations, wallet/private-key operations, signing, asset transfer, and unrestricted outbound network access disabled.
- Keep the default-deny policy in force.
- Use synthetic test data and an isolated environment only.

The repository is public. A Git branch or a Draft PR is not a private beta distribution mechanism. Any future beta access channel must be designed separately and must not rely on source-code repository visibility as an access-control boundary.

## 2. Evidence snapshot and known facts

The repository default branch is `main`; the Agent V1 implementation under review is on `integration/infinyx-agent-v1-audit-hardening`, not on `main`.

The reviewed Agent V1 PR is #38 and remains open/Draft. Its latest recorded head is `f6f201ceeaa9511fbaab31e9a9999d5ed6308af8`.

A GitHub Actions run, #43772749166, is recorded as successful with four jobs: Ubuntu, macOS, Windows, and Dependency Security Audit. The three platform jobs completed type check, build, unit/API tests, loopback runtime smoke test, and process lifecycle tests. The audit job completed at the configured `high` threshold.

**Important evidence limitation:** the PR description records that this successful run was on an earlier parent SHA, not the current latest head. The latest head has no combined commit statuses in the retrieved status response. Therefore, this run is useful historical evidence, but it does not satisfy exact-head CI acceptance for the current candidate.

The PR description also records a partial DeepSeek review, not a complete independent security certification. The latest head includes code and documentation updates whose complete acceptance still needs to be verified.

## 3. Candidate assembly gate — BLOCKED

Before beta qualification, select and assemble one traceable candidate. Do not merge unrelated branches by guesswork.

Known relevant open Draft work at assessment time includes:

- PR #38 — Agent V1 integration and audit hardening.
- PR #41 — protected-operation input snapshot hardening; targets the Agent V1 integration branch and is not merged.
- PR #42 — CI trigger correction for Agent V1 integration PRs; targets the Agent V1 integration branch and is not merged.
- PR #7 and the protected-operation/policy hardening chain — core runtime and policy dependencies whose acceptance and integration must be reconciled against the selected candidate.

Required evidence:

- A candidate branch, exact base/head SHAs, and a written dependency graph.
- A reviewed decision for each dependency: included, superseded, or explicitly excluded with rationale.
- No unresolved merge conflicts or stale-base assumptions.
- A complete changed-file and commit review.
- Fresh exact-head CI after final candidate assembly.
- A release manifest recording source SHA, build identifier, dependency-lockfile hash, and test evidence.

Do not merge to `main`, tag, or deploy as part of this gate.

## 4. Agent runtime and policy gate — BLOCKED

The candidate must demonstrate, with deterministic regression tests:

- Correct task admission, lifecycle transitions, cancellation, timeout, and shutdown behavior.
- No claim that a caller timeout or cancellation proves underlying provider work has stopped.
- Capacity remains occupied while an underlying provider promise is unresolved; saturation fails closed.
- No duplicate task execution or ambiguous terminal-state transitions.
- Safe handling of late provider completion/rejection after timeout or cancellation.
- Sanitized provider/evaluator errors and no leakage of secrets, prompts, tokens, stack traces, or child-process stderr through public results.
- Bounded input, output, concurrency, execution time, and memory/resource consumption.
- Fail-closed behavior for malformed requests, invalid policy decisions, unavailable dependencies, and uncertain execution outcomes.
- Explicit behavior and tests for shutdown/restart limitations and any accepted residual risks.

Every known finding must have an owner, severity, remediation evidence, and disposition. A documentation-only note does not close a runtime defect.

## 5. Identity, authorization, and tenant boundary — NOT IMPLEMENTED / NOT VERIFIED

The current security baseline states that authentication, authorization, trusted identity derivation, and tenant isolation are not implemented or verified.

Before any beta involving multiple users or organizations:

- Authenticate every user through a reviewed identity mechanism.
- Derive actor and tenant identity from trusted server-side context, never from caller-supplied identifiers alone.
- Enforce authorization at every agent/task/resource boundary.
- Prove cross-tenant isolation with negative tests, including IDs, logs, task status, caches, and any future memory.
- Define session expiry, revocation, abuse throttling, and administrative access.
- Ensure beta users cannot invoke internal or privileged operations.

Until these controls are implemented and independently reviewed, beta must remain a single-operator or otherwise explicitly isolated engineering evaluation; it must not be represented as a multi-tenant customer beta.

## 6. Prompt, model, and tool safety — BLOCKED

Before enabling model-backed or tool-using workflows, provide a threat model and tests covering:

- Direct and indirect prompt injection, including untrusted retrieved content.
- Strict separation of instructions, user input, and untrusted tool/model output.
- Tool allowlists, typed schemas, argument validation, and per-tool authorization.
- No arbitrary shell, filesystem, browser, network, or code execution.
- SSRF protections and outbound destination allowlists if any network access is later enabled.
- Secret isolation and redaction in prompts, traces, logs, and error paths.
- Human approval for any consequential external side effect.
- Explicit denial of financial, wallet, signing, transfer, and privileged actions in this first beta scope.

A separate Node.js child process is not an operating-system sandbox. Filesystem, network, process identity, and resource access require deployment-level containment and independent validation.

## 7. Data, memory, and privacy gate — RESTRICTED

The reviewed baseline describes no durable persistence and only guarded in-memory reference storage in the core integration.

For the first restricted beta:

- Use synthetic, non-sensitive data only unless a separately reviewed data design is approved.
- Do not promise persistence, memory across restarts, backup/restore, or deletion guarantees where they do not exist.
- Do not store credentials, API keys, payment data, or personal/sensitive information.
- Document what is logged, retention periods, access, and deletion behavior.
- Ensure secrets and sensitive values are redacted from logs and diagnostics.
- If durable storage is introduced, require encryption, key ownership/rotation, retention/deletion, backup/restore, access-control, and audit designs before use.

## 8. CI, test, and supply-chain gate — PARTIALLY EVIDENCED

For the exact final candidate, require:

1. `npm ci`
2. `npm run typecheck`
3. `npm run build`
4. `npm test`
5. `npm run test:process`
6. Loopback runtime smoke tests and graceful shutdown verification.
7. Ubuntu, macOS, and Windows results, with platform-specific skips explained.
8. Dependency audit and explicit review of all advisories, not merely the configured threshold.
9. Secret scanning and dependency/workflow pinning review.
10. CI evidence attached to the exact candidate SHA.

The existing audit threshold is `high`; a passing result is not proof that no low- or moderate-severity advisories exist. Third-party GitHub Actions should be pinned to immutable commit SHAs as a supply-chain hardening requirement.

## 9. Operations and beta controls — NOT ACCEPTED

Before onboarding even a small beta cohort, document and test:

- Isolated hosting, network boundaries, and least-privilege runtime identity.
- Health versus readiness semantics.
- Resource quotas, concurrency limits, abuse controls, and cost ceilings.
- Centralized monitoring, alerting, trace correlation, and safe log redaction.
- Graceful shutdown, restart, stuck-task handling, and operator recovery.
- Incident response, security contact, beta suspension/kill switch, and rollback.
- Versioned API/agent contracts and compatibility policy.
- User consent, beta terms, data-use disclosure, and feedback/issue reporting.
- A named operator and a tested runbook.

## 10. Independent review and governance — REQUIRED

- Technical acceptance must identify the exact candidate SHA and all residual risks.
- DeepSeek review is an additional independent review input, not a security certification.
- A reviewer who authored the implementation cannot be the sole independent approver.
- Require independent security review of the exact candidate, including identity, tenant boundaries, prompt/tool safety, process containment, and operational controls.
- Record review findings and their disposition; silence is not approval.
- Merge authorization, release authorization, and deployment authorization are separate decisions.
- Founder approval is required separately for release and for deployment.

## 11. Final Private Beta decision checklist

- [ ] Candidate branch, base/head SHAs, and dependency map accepted.
- [ ] PR #38 and all required dependency PRs reconciled and reviewed.
- [ ] All critical/high runtime and policy findings fixed or explicitly rejected from scope with an approved risk decision.
- [ ] Agent lifecycle, cancellation, timeout, capacity, and shutdown tests pass on the exact candidate.
- [ ] Authentication, trusted identity, authorization, and tenant isolation implemented and independently tested if multiple beta users/tenants are admitted.
- [ ] Tool execution remains disabled unless separately threat-modeled, allowlisted, authorized, sandboxed, and approved.
- [ ] Synthetic-data-only restriction enforced and disclosed.
- [ ] Exact-head cross-platform CI and supply-chain checks pass.
- [ ] Operational runbook, monitoring, kill switch, incident response, and rollback tested.
- [ ] Independent security review completed on the exact candidate.
- [ ] Founder separately authorizes the release and the deployment.

**Current decision: NOT READY.** The immediate next step is to reconcile the Agent V1 dependency chain and establish exact-head CI and independent review evidence. This document is a readiness plan only; it does not authorize a merge, tag, release, deployment, public exposure, or activation.
