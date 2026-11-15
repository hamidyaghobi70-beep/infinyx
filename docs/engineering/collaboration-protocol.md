# INFINYX Collaboration Protocol

**Status:** Proposed for adoption with Revision v6  
**Scope:** Repository changes, lifecycle engineering, reviews, CI evidence, and release decisions.

## Authority and sources of truth

- **INFINYX** is the project and owns its architecture, implementation, tests, and technical records.
- **GitHub** is the canonical record for source code, branches, commits, pull requests, and CI results.
- **Automated tests and CI** are evidence of observed behavior for the scenarios they execute; they do not prove the absence of all defects.
- **Independent reviewer** examines architecture, implementation, failure modes, and test coverage without treating the implementer's conclusions as authoritative.
- **Technical coordinator** defines the mission, maintains architectural coherence, reconciles findings, and prepares the evidence-based handoff.
- **Project owner** retains final authority over sensitive changes and merge approval.

No AI system is, by itself, the source of truth or final approval authority.

## Responsibilities

| Role | Responsibility | Authority boundary |
| --- | --- | --- |
| Project owner | Prioritizes work, approves sensitive changes, and decides whether to merge | Sole final merge authority |
| Technical coordinator | Defines acceptance criteria, coordinates implementation and review, and resolves disagreements through reproducible evidence | Does not merge without owner authorization |
| Coding implementer | Changes code on an isolated branch, adds tests, records commits, and reports actual CI results | Does not modify protected or out-of-scope branches |
| Independent reviewer | Audits the base revision and proposed diff; records file, scenario, impact, reproduction, and remediation | Review findings are advisory until evaluated and accepted |
| GitHub CI | Executes the repository's declared validation workflow and stores logs/results | Reports execution evidence, not architectural approval |

## Required change lifecycle

1. Record the base branch and exact base commit SHA.
2. Create a dedicated work branch from that exact SHA.
3. Inspect the full relevant implementation, tests, configuration, and recent history before editing.
4. Implement in small, independently reviewable commits.
5. Add regression tests for each discovered defect and integration tests for externally observable behavior.
6. Run typecheck, build, unit/integration tests, process-level tests where relevant, and dependency/security audit.
7. Obtain an independent review of the exact final commit.
8. Reconcile every finding as fixed, accepted risk, or explicitly unresolved, with evidence.
9. Deliver commit SHAs, CI run links, test counts, audit result, changed files, and remaining risks to the project owner.
10. Merge only after separate, explicit owner authorization.

## Non-negotiable controls

- Never change the base or protected branches as part of a revision task.
- Never force-push.
- Never merge, enable auto-merge, or bypass required review without separate owner authorization.
- Never conceal a failed test, skipped audit, flaky test, or known defect to obtain a green CI result.
- A test double is not a substitute for a real process or external integration test when the requirement concerns operating-system behavior.
- Record disagreements and resolve them with a reproducible test, trace, or documented reasoning.
- Internal project records identify contributors by role and responsibility, not personal names.

## Revision handoff checklist

- [ ] Exact base SHA and final revision SHA recorded
- [ ] Scope and changed-file list reviewed
- [ ] Unit, integration, and process-level tests pass
- [ ] Typecheck and build pass
- [ ] Security audit passes or findings are explicitly documented
- [ ] Independent review covers the exact final SHA
- [ ] Every review finding has a disposition
- [ ] Remaining risks and limitations are stated
- [ ] Owner has explicitly authorized any merge
