# INFINYX Branch and PR Reconciliation
**Date:** 2026-11-17  
**Status:** DOCUMENTED / RECONCILIATION PLAN ONLY  
**Repository:** hamidyaghobi70-beep/infinyx

## Executive decision

Do not merge PR #49 directly into `main`, and do not rebase or force-update its existing branch as a shortcut. PR #49 is a focused 33-commit change on top of `fix/policy-hard-termination-escalation`; the apparent 271-commit divergence from `main` is inherited branch history, not the PR's own delta. The correct next step is to select and validate a canonical integration baseline, then port/reconcile focused changes in dependency order with exact-SHA CI and review gates.

No branch was rewritten, no PR was retargeted, and no merge, release, deployment, or Agent/Tool activation was performed in this reconciliation.

## 1. Repository anchors observed

- `main`: `1414171de70b88573e3749e46734c00c27f29c24`
- Common ancestor reported by compare for the main-derived engineering streams: `8500c4098372abb1c29f46ad518e7b87202bd403`
- `fix/policy-hard-termination-escalation` current PR #49 base SHA: `bd0999e884015ec4903b2a86a5d9a05d3e2888e8`
- PR #49 head: `f65c76d3c052dba9fa0002454f99244a0481ca18`
- PR #38 Agent integration head: `f6f201ceeaa9511fbaab31e9a9999d5ed6308af8`
- PR #48 snapshot head: `623a519ab3eeebe868812a417c5b2bb411b83f23`
- PR #41 protected-operation snapshot head: `b0af436fb2f3b433bab7be6028b643d8f2a58b93`
- PR #32 audited head: `9b67655819360394a05a8d3f97fc2d0135d2bc0e`; merge commit recorded as `b654d7774a2adbba761a87d8584830989f97f83a`.

These are observed refs at audit time; re-fetch before any future write or integration.

## 2. Branch topology and divergence

| Ref / PR | Relationship observed | Interpretation |
|---|---|---|
| `fix/policy-hard-termination-escalation` vs `main` | 238 ahead, 2 behind; diverged at `8500c409...` | Contains a large foundational Core/runtime line absent from main. Not a small feature branch. |
| PR #49 head vs its declared base | 33 ahead, 0 behind; merge base `bd0999e...` | PR #49's actual delta is 33 commits. |
| PR #49 head vs `main` | 271 ahead, 2 behind; diverged at `8500c409...` | The 271 count includes inherited base history. Do not interpret it as 271 PR-specific commits. |
| `integration/infinyx-agent-v1-audit-hardening` vs `main` | 202 ahead, 2 behind; diverged at `8500c409...` | Separate large Agent integration line, also not a small feature branch. |
| `fix/policy-hard-termination-escalation` vs Agent integration | 94 ahead, 58 behind; merge base `683074174c140ee67620ee98ba5d55ecfbdef006` | These streams have materially diverged and overlap in core policy/runtime files. Do not merge one wholesale into the other. |
| PR #48 head vs its declared Agent integration base | 11 ahead, 0 behind | Focused snapshot change on Agent integration line. |
| PR #41 head vs its declared Agent integration base | 7 ahead, 0 behind | Separate focused snapshot change on the same base. |
| PR #32 head vs `fix/policy-hard-termination-escalation` | head is 7 commits behind; no unique ahead commits | PR #32's reviewed head is already in the ancestry of the current base branch. |
| PR #34 head vs its declared base | 1 ahead, 0 behind | Clean hard-termination branch is based on `fix/policy-terminal-authorization`, a distinct line. |

## 3. PR #49 exact scope

PR #49 is open and Draft, base `fix/policy-hard-termination-escalation`, head `spike/issue-29-posix-process-containment-2026-11-17`. GitHub reports 33 commits, 13 changed files, 816 additions, and 171 deletions.

Changed files:
- `.github/workflows/ci.yml`
- `PROCESS_CONTAINMENT_SPIKE.md`
- `docs/engineering/ISSUE-29-WINDOWS-JOB-LAUNCHER-DESIGN.md`
- `docs/engineering/ISSUE-29-WINDOWS-JOB-LAUNCHER-POC.md`
- `docs/engineering/ISSUE-29-WINDOWS-NAMED-PIPE-TRANSPORT-DESIGN.md`
- `native/windows/job-launcher-poc.c`
- `package.json`
- `src/core/process-containment.ts`
- `src/core/process-isolated-policy-engine.ts`
- `test/core/process-isolated-policy-engine.test.ts`
- `test/fixtures/policy-evaluator-fixture.mjs`
- `test/windows/ipc-child.mjs`
- `test/windows/job-launcher-ipc-poc.test.mjs`

### Technical status and limitations

- POSIX uses a dedicated session/process group, group signalling, and waits for group-empty confirmation. The stated capability is `POSIX_PROCESS_GROUP_BEST_EFFORT`.
- The detached-session fixture explicitly demonstrates an escape from the process group. This is not a sandbox and is not a hostile-code security boundary.
- Windows remains `DIRECT_CHILD_ONLY`.
- The native Job Object POC did not establish transparent Node IPC forwarding: the child reported `process.connected === true`, then `process.send()` failed with `EPIPE`.
- The Named Pipe document is a design proposal only. No Named Pipe implementation or engine integration exists.
- The PR body identifies the last fully successful four-job matrix as run `43992493170` on SHA `a5a73117b82ba467a8c60900893c97ce2886892e`. The later head `f65c76d...` is not established as having the same four-job exact-head evidence. A successful workflow record without verified job-level evidence must not be represented as a full matrix pass.

## 4. Dependency and overlap map

### Core policy / process lifecycle line
`fix/policy-terminal-authorization` → `fix/policy-hard-termination-final` (PR #34) is a clean, focused hard-termination branch.  
Separately, `fix/policy-hard-termination-escalation` contains the PR #32 terminal-commit-veto work in its ancestry and is the declared base for PR #49.  
PR #49 depends on the latter base's process-isolated policy engine and terminal arbitration behavior. Its process lifecycle changes must be reconciled against that exact base, not cherry-picked onto old `main`.

### Agent integration / protected-operation line
`main` → `integration/infinyx-agent-v1-audit-hardening` (PR #38) is a large Agent/Core integration stream.  
PR #48 and PR #41 are separate focused changes on this same Agent integration base:
- #48 adds bounded immutable policy-input snapshotting and modifies `protected-operation-executor.ts`.
- #41 adds protected-operation input snapshot behavior and also modifies `protected-operation-executor.ts` and its tests.
- Their shared file overlap means they need semantic reconciliation and a combined regression suite; do not merge both mechanically or assume one subsumes the other.

### Cross-stream conflict boundary
The hard-termination line and Agent integration line diverge from a shared ancestor and both modify core policy/runtime files, including `contracts.ts`, `fail-closed-policy-engine.ts`, `policy-evaluator-child.ts`, `process-isolated-policy-engine.ts`, `protected-operation-executor.ts`, CI, and related tests. The compare reported 94 commits unique to the hard-termination line and 58 unique to the Agent line. This is a material integration boundary, not a routine branch update.

## 5. Recommended reconciliation sequence

1. **Freeze current evidence:** retain all existing Draft PRs and branch heads; re-fetch refs and exact CI before work begins.
2. **Choose a canonical foundation:** compare the current `main`, Agent integration, and hard-termination branch contents and product/runtime scope. Make an explicit architecture decision about which line becomes the integration foundation; do not infer this from commit counts.
3. **Reconcile policy lifecycle first:** preserve PR #32's terminal-commit-veto invariants and the chosen hard-termination implementation. Review PR #34's distinct base and selectively port only after a file-level semantic comparison.
4. **Reconcile process containment on its own dependency base:** validate PR #49 against its declared base, run exact-head Ubuntu/macOS/Windows and dependency-audit jobs, then obtain independent review. Keep POSIX best-effort and Windows direct-child-only labels unchanged until evidence justifies a change.
5. **Reconcile protected-operation input boundaries:** compare #48 and #41 at function/test level, decide the canonical snapshot contract, integrate once, and test executor lifecycle, mutation resistance, UTF-8 byte accounting, and failure paths together.
6. **Reconcile shutdown/lifecycle contracts:** evaluate PR #18 and related lifecycle work against the selected canonical Core baseline; do not import an old base wholesale.
7. **Create small, reviewable integration PRs:** each should target the chosen integration branch, remain Draft, and carry exact base/head SHAs, changed-file inventory, tests, CI run IDs, limitations, and independent-review status.
8. **Only after all gates:** request explicit authorization for any merge beyond the isolated engineering branches. Main, release, deployment, external data egress, and Agent/Tool activation remain outside this work.

## 6. Blocking gates before PR #49 can be considered for integration

- Exact-head CI evidence for the current PR head, including Ubuntu, macOS, Windows, and dependency audit.
- Linux and macOS process-group race/PID-reuse analysis and reproducible descendant cleanup evidence.
- Explicit acceptance that POSIX process groups are best-effort, or replacement with a stronger OS boundary if evaluator code is hostile.
- A standalone Windows Named Pipe POC proving ACL behavior, local-only connection, expected peer PID verification, nonce/execution binding, bounded framing, malformed/oversized input rejection, backpressure, disconnect behavior, and crash cleanup.
- Job Object active-process count reaches zero before capacity release; no allow result after relay/cleanup failure.
- Exact-head Windows native compilation and integration tests.
- Independent security review of native handle ownership, ACLs, PID verification, framing, relay, Job lifecycle, and claims.
- No capability upgrade from `DIRECT_CHILD_ONLY` until all Windows gates pass.

## 7. Governance and non-claims

- This document records a branch/PR reconciliation analysis; it is not a security audit or release approval.
- No code was changed by this analysis.
- No PR was merged or retargeted.
- No branch was rebased, force-pushed, or deleted.
- No changes were made to `main`.
- No external reviewer/provider received repository content.
- No release, deployment, production activation, or Agent/Tool activation is authorized.
