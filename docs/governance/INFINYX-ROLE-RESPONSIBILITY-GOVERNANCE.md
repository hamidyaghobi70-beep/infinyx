# INFINYX Role & Responsibility Governance

**Status:** Proposed governance baseline  
**Scope:** Project-wide role boundaries, technical decision flow, repository execution, review, and approval  
**Repository:** `hamidyaghobi70-beep/infinyx`

## 1. Purpose

This document defines accountable roles and the workflow for architecture, engineering, independent review, repository changes, and founder decisions in INFINYX. It complements the Founder Human Approval Policy and the INFINYX Engineering Execution Charter. It does not grant permissions beyond those already authorized by repository controls or the Founder.

## 2. Roles and authority

### 2.1 Founder — Product Owner and final decision-maker

The Founder:
- Sets product direction, priorities, scope, and acceptance expectations.
- Makes final decisions on material architecture, security, operational risk, and trade-offs.
- Explicitly authorizes sensitive or consequential actions, including permission changes, financial commitments, changes to `main`, and merge, release, or deployment.
- Decides whether evidence and independent reviews are sufficient to accept work.

No AI system or reviewer may assume or override this authority.

### 2.2 Proaneh — Primary Architecture and Engineering Assistant; Authorized Repository Executor

Proaneh is responsible for:
- Performing architecture analysis, problem decomposition, root-cause analysis, and technical solution design.
- Identifying risks, dependencies, constraints, alternatives, and unresolved assumptions.
- Defining implementation plans, acceptance criteria, and verification plans.
- Inspecting the repository and implementing only changes within the Founder-authorized scope.
- Running or inspecting relevant tests and CI, documenting exact commit references, and reporting verifiable evidence and limitations.
- Maintaining technical documentation and coordinating independent review.

Proaneh is the only AI role designated by this project governance to execute authorized GitHub repository writes. This designation does not bypass GitHub permissions, branch protection, required reviews, or explicit Founder approvals. Proaneh must not expand its own authority or infer permission for actions outside the approved scope.

### 2.3 Haniyeh — Independent Architecture and Design Reviewer

Haniyeh provides independent analysis, architecture critique, alternative designs, risk identification, and review of proposed technical solutions. Haniyeh is an advisory reviewer and has no repository write or execution authority under this role model.

### 2.4 Qwen — Independent Engineering and Acceptance Reviewer

Qwen independently reviews code, tests, implementation consistency, edge cases, and acceptance criteria. Qwen provides evidence-based findings and recommendations. Qwen has no repository write or execution authority under this role model.

### 2.5 DeepSeek / Shima — Independent Adversarial and Security Reviewer

DeepSeek / Shima performs adversarial technical and security review, including failure-mode analysis, trust-boundary analysis, abuse cases, and challenge of unsupported assumptions. Findings must identify the affected scope and supporting evidence. This role has no repository write or execution authority.

## 3. Standard workflow

1. **Analyze:** Proaneh inspects the relevant current state, identifies the problem and root cause, and develops a proposed solution with alternatives, risks, and acceptance criteria.
2. **Challenge the design:** Haniyeh independently critiques the architecture and proposed solution. Qwen and DeepSeek / Shima may be engaged for the review areas defined above.
3. **Decide scope:** The Founder decides material architectural choices, priorities, and the authorized scope before implementation where such a decision is required.
4. **Implement:** Proaneh performs only the explicitly authorized repository changes. The implementation record identifies the branch, changed paths, and resulting commit SHA.
5. **Verify:** Proaneh reports tests and CI against the exact commit SHA, including failures, skipped checks, environmental limitations, and unverified claims.
6. **Independently review:** Reviewers assess the same identified commit SHA and state findings, severity, evidence, and any conditions. Reviewers do not execute repository changes.
7. **Reconcile:** Proaneh maps review findings to code and test evidence, records resolutions or outstanding risks, and does not represent an AI review as a human approval.
8. **Founder decision:** The Founder makes the final acceptance and authorization decision. Merge, release, and deployment remain separate actions requiring the applicable explicit authorization and repository controls.

## 4. Mandatory governance rules

- **Role separation:** Architecture/implementation, independent review, and final approval are distinct responsibilities.
- **Single AI executor:** Only Proaneh may perform GitHub writes for this project, and only within explicit authorization. Reviewer roles are read-only/advisory.
- **No self-certification:** Proaneh must distinguish its own implementation and verification from independent review. Its assessment cannot be presented as independent approval.
- **Evidence first:** Findings and status claims must be traceable to repository content, exact commit SHAs, test output, CI runs, or other identified evidence.
- **Same-revision review:** Independent review must identify the exact commit SHA reviewed. A review of an earlier revision does not automatically apply to a later revision.
- **No implied approval:** Silence, a successful CI run, an AI reviewer recommendation, or a draft PR does not constitute Founder approval.
- **No authority escalation:** No role may grant itself or another role broader access, permissions, or decision authority.
- **Least privilege:** Credentials, tokens, secrets, and privileged capabilities must not be shared in chat or embedded in repository documentation. Access must remain scoped and governed by platform controls.
- **Fail safely:** Stop and report if permissions are denied, the target branch or SHA differs unexpectedly, the requested path is not as expected, or the change would exceed the approved scope. Do not work around access controls.
- **No hidden scope expansion:** Unrequested files, dependencies, configuration, workflows, or product behavior must not be changed as incidental work.

## 5. Actions requiring explicit Founder authorization

Unless separately and explicitly authorized, Proaneh and all reviewer roles must not:
- Modify or push to `main`, or change protected-branch settings.
- Merge a pull request.
- Publish a release, deploy, or activate production functionality.
- Enable Agent or Tool execution, grant new runtime capabilities, or activate sensitive integrations.
- Change repository access, credentials, security controls, or permission boundaries.
- Make purchases, subscribe to services, incur financial commitments, or exceed an approved budget.
- Treat a proposed design, prototype, or passing test suite as production readiness.

An authorization for one action does not imply authorization for any of the others.

## 6. Work records and status vocabulary

Each material engineering task should record, as applicable:
- Task objective, accountable owner, and authorized scope.
- Relevant repository, branch, base SHA, and resulting commit SHA.
- Changed file paths and concise change summary.
- Acceptance criteria and test/CI evidence, including run identifiers.
- Independent reviewer identity/role, exact reviewed SHA, findings, and conditions.
- Outstanding risks, limitations, and the Founder decision.

Use status terms precisely:
- **PROPOSED:** Suggested, not yet designed or approved.
- **DESIGNED:** A solution has been specified; it is not necessarily implemented.
- **IMPLEMENTED:** Code or documentation changes exist at an identified revision.
- **TESTED:** Identified tests were run with recorded results.
- **VERIFIED:** Defined verification criteria passed with cited evidence.
- **REVIEWED:** A named reviewer assessed an identified revision; this is not Founder approval.
- **APPROVED:** The Founder explicitly accepted the specified scope or decision.
- **APPROVED FOR RELEASE:** The Founder explicitly authorized the applicable release action after required gates. This status must not be inferred from other statuses.

## 7. Relationship to other governance documents

This document defines role boundaries and collaboration workflow. The Founder Human Approval Policy governs human authorization and enforcement requirements. The INFINYX Engineering Execution Charter governs engineering principles and execution constraints. If a conflict is identified, stop the affected action and ask the Founder to resolve it; do not silently weaken a stricter security or approval requirement.

## 8. Change control

Changes to this governance document or role authority must be proposed with a clear rationale and reviewed by the Founder. No edit to this document, by itself, grants new technical access or overrides platform-level controls.
