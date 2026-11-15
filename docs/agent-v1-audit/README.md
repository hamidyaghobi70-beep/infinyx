# INFINYX Agent V1 — Independent Audit Evidence Package

**Status: draft / evidence incomplete.** This directory is an evidence index, not a claim that all checks have passed. Replace every `PENDING` entry with an attached artifact or an explicit `NOT AVAILABLE` / `OUT OF SCOPE` statement before submitting the package to an independent auditor.

## Target identity

- Target branch: `integration/infinyx-agent-v1-audit-hardening`
- Target SHA: record the final branch head in the external audit cover note (this README is itself part of the target commit, so it cannot contain its own final SHA).
- Starting SHA: `7c3ea806c8541966a9bf13e2743060117c2402b6`
- Diff base SHA: `7c3ea806c8541966a9bf13e2743060117c2402b6`.
- `main` SHA at comparison time: `6eb55bd5b22aabd148b1fcb846c083752c49a8cc`.

## Required evidence

| # | Evidence | Status / required artifact |
|---:|---|---|
| 1 | Target SHA (not a temporary PR merge commit) | Record exact final head in external audit cover note; this README cannot contain its own commit SHA |
| 2 | Exact diff-base SHA | `7c3ea806c8541966a9bf13e2743060117c2402b6` |
| 3 | Full `git log --oneline BASE..TARGET` output | Ten commits through parent SHA `ec1cc9bb3d6010851ee563b668459fce1ea5cdac` are listed below; the ledger-refresh commit is in the external cover note |
| 4 | `git diff BASE..TARGET --stat` output | PENDING |
| 5 | Complete `git diff BASE..TARGET` | PENDING |
| 6 | Raw CI logs run directly against TARGET: macOS, Windows, Ubuntu, security audit | Direct-SHA run `43711220007` passed on parent SHA `ec1cc9bb3d6010851ee563b668459fce1ea5cdac`; attach the final-head run linked in the external cover note |
| 7 | `npm audit --json` output from TARGET | Artifact `dependency-security-audit` exists for run `43711220007`; attach the artifact from the final-head run as well |
| 8 | Comparison against `main`: ahead/behind, merge-base, current main SHA, and exact behind commit | Current comparison recorded below; behind commit decision remains OPEN |
| 9 | Decision on commit `6eb55bd5b22aabd148b1fcb846c083752c49a8cc` (reported documentation commit) | OPEN — it is the one commit on `main` not contained in this branch; do not cherry-pick without an explicit decision |
| 10 | Capacity contract at the exact target SHA | `docs/agent-runtime-capacity.md`; verify using the target SHA in the external cover note |
| 11 | Requirement-to-test traceability table | INCLUDED ABOVE |
| 12 | V1 limitation statement: non-cooperative provider and no forced termination | INCLUDED IN `docs/agent-runtime-capacity.md`; verify at target SHA |
| 13 | Explicit audit exclusions / non-claims | INCLUDED BELOW |
| 14 | Statement distinguishing prior PR merge-commit CI from direct-SHA CI | INCLUDED BELOW; direct-SHA run on parent SHA passed, final-head run must be linked in external cover note |

## Requirement-to-test traceability

| Requirement | Test evidence |
|---|---|
| Synchronous admission and capacity bound | `reserves all capacity synchronously before provider promises settle` in `test/agent/agent-runtime.test.ts` |
| Release after successful provider settlement | `releases all capacity slots after successful provider settlement` in `test/agent/agent-runtime.test.ts` |
| Release after provider error | `releases all capacity slots after provider errors settle` in `test/agent/agent-runtime.test.ts` |
| Caller AbortSignal propagation | `propagates caller AbortSignal to ModelPort` in `test/agent/agent-cancellation.test.ts` |
| Cancellation before provider invocation | `does not invoke ModelPort when shutdown wins before the provider microtask` in `test/agent/agent-cancellation.test.ts` |
| Capacity remains occupied after cancellation when provider ignores signal | `does not release capacity for a cancelled non-cooperative provider` in `test/agent/agent-cancellation.test.ts` |
| Capacity release after late settlement | `releases capacity after timed-out providers eventually settle` and `keeps unresolved tasks in the active capacity until their providers settle` in `test/agent/agent-cancellation.test.ts` |

## Explicit V1 operational limitation

A provider may ignore AbortSignal and return a Promise that never settles. Such a task continues to hold its runtime capacity slot indefinitely. If 32 such tasks are active/unresolved, new valid tasks are rejected with `CAPACITY_EXCEEDED`. V1 has no forced termination or independent hard cap for unresolved provider operations. AbortSignal is cooperative only.

## Prior CI qualification

The previously reported successful workflow run `43709839485` checked out a temporary PR merge commit (`f67de10`), not the target commit directly. It must not be described as direct-target-SHA CI. A later push-triggered run `43711220007` checked out parent SHA `ec1cc9bb3d6010851ee563b668459fce1ea5cdac` directly and passed on macOS, Windows, Ubuntu, and dependency audit. The final branch-head run after this ledger refresh must be recorded in the external audit cover note.

## Audit scope and exclusions

Unless separate evidence is added, this package does **not** claim to provide:

- an independent security audit of all dependencies beyond the attached npm audit output;
- a formal proof of JavaScript runtime scheduling or concurrency properties;
- validation of every ModelPort implementation or third-party provider;
- load, soak, fault-injection, or production-scale testing;
- distributed/global concurrency enforcement across processes or runtime instances;
- verification of deployment, release, or production configuration;
- an independent DeepSeek audit (that review has not yet been performed).

## Branch and release guardrails

- Do not merge this branch.
- Do not release or deploy.
- Do not modify `main`.
- Keep unresolved evidence items visibly marked as pending.


## Exact commits added after the starting SHA

Base: `7c3ea806c8541966a9bf13e2743060117c2402b6`

The following ten commits are the complete sequence from that base through parent SHA `ec1cc9bb3d6010851ee563b668459fce1ea5cdac` (newest first). The commit that refreshes this ledger is intentionally recorded in the external audit cover note to avoid a self-referential SHA.

| SHA | Commit message |
|---|---|
| `1094d24301c192f0e61c7fb56b98d514ecabad8e` | test(agent): preserve provider error and output validation cases |
| `ec1cc9bb3d6010851ee563b668459fce1ea5cdac` | docs(agent): finalize audit index and commit ledger |
| `6095a1155b4c4526d79789ddc0751c309dd30f39` | docs(agent): record commit history and main comparison evidence |
| `8e8db5ed92fa350541d769f9ff90dd4695fbe364` | ci: run direct verification on agent audit branch |
| `864a5dc8b15b7c808df683168ef6e203c006417e` | docs(agent): add independent audit evidence checklist |
| `966ba9f2f453ea7b1dddff2782f4f46729c0cf80` | docs(agent): clarify execution state and capacity contract |
| `e7300388ee8b8e6d3de55cc83a01adf1baf2e51c` | test(agent): retain capacity for non-cooperative providers |
| `e6cf64fef79e2c545bc745c2b985a4c9c3593952` | test(agent): verify synchronous capacity reservation |
| `a1993d2da5472802192106f13ad4103b309e1ee3` | docs(agent): clarify execution state semantics |
| `93535c26e213ba5ef75f597cf96578b76973e943` | docs(agent): document cooperative ModelPort cancellation |

## Current comparison against main

At the comparison immediately before this ledger refresh:

- `main` SHA: `6eb55bd5b22aabd148b1fcb846c083752c49a8cc`
- Merge base: `8500c4098372abb1c29f46ad518e7b87202bd403`
- Branch head: `ec1cc9bb3d6010851ee563b668459fce1ea5cdac`
- Branch ahead: 175 commits
- Branch behind: 1 commit
- The one commit on `main` not contained in the branch is `6eb55bd5b22aabd148b1fcb846c083752c49a8cc`, titled `docs(strategy): add INFINYX master vision and architecture v3.0`.

For historical context, the same current `main` SHA compares to the earlier base `9302339b1e78bbc0220297644945f871571bd84f` as 160 ahead / 1 behind, and to the prior target `7c3ea806c8541966a9bf13e2743060117c2402b6` as 165 ahead / 1 behind. The ten commits listed above account for 165 → 175. The older reported value 154 cannot be reconstructed from the available historical main SHA; against the current main SHA, the same `9302339...` base is 160 ahead. The old 154 figure therefore remains historically unexplained rather than being attributed to these five or nine commits.

