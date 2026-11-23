# Engineering Execution Rules — INFINYX

**Scope:** Engineering work on the active project branch  
**Status:** Operational working rules; does not amend project governance.

## Required engineering practice

1. Inspect the current implementation, interfaces, dependencies, and relevant tests before changing code. Do not implement from assumptions when repository evidence is available.
2. Make changes in the repository and record them as Git commits on the authorized working branch. For each change, preserve the exact commit SHA and identify the files changed.
3. Verify each change by running the relevant available tests and checks. Report a test as passing only when it was actually executed and its successful result was observed. Distinguish code inspection, file updates, commits, test results, CI results, and merges.
4. Do not describe the core as complete until all required components, their integration, and the relevant verification have been demonstrated.
5. Do not fabricate external service integrations, credentials, keys, identity-provider configuration, or key-management configuration. Keep security-sensitive startup paths fail-closed when required real configuration is absent; implement and test safe configuration contracts and adapters without pretending a live integration exists.
6. Keep technical communication concise and evidence-based. These rules do not authorize progress reports, status dashboards, or other reporting artifacts prohibited by the active reporting directive.

## Existing governance remains controlling

These working rules do not authorize merging PRs #60 or #61, releasing, deploying, activating the Agent, or granting Phase 0. PRs #60 and #61 remain Draft and unmerged; the Agent remains OFF; Phase 0 remains NOT GRANTED. The active `docs/governance/REPORTING-PROHIBITION.md` remains in force. If any wording here appears to conflict with that directive, the directive controls.
