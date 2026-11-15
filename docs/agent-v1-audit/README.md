# INFINYX Agent V1 — Independent Audit Evidence Package

**Status: draft / evidence partially complete.** This index records verifiable evidence and open items. It is not a claim of independent security approval, production readiness, or complete audit coverage.

## Target identity

- Target branch: `integration/infinyx-agent-v1-audit-hardening`
- Snapshot head for the ledger below: `3a583859a64fc61a2d4b899a905cf0f93ad3f3e6`
- Starting SHA and diff base: `7c3ea806c8541966a9bf13e2743060117c2402b6`
- `main` SHA used for comparison: `6eb55bd5b22aabd148b1fcb846c083752c49a8cc`
- The final README-refresh commit and final target SHA are recorded in the external cover note / final response, because a commit cannot contain its own SHA.

## Evidence status

| # | Evidence | Status |
|---:|---|---|
| 1 | Exact target SHA | Snapshot SHA above; final README-refresh SHA must be recorded externally |
| 2 | Exact diff base | Recorded above |
| 3 | Commit ledger | 13 commits through snapshot SHA listed below; final README-refresh commit recorded externally |
| 4 | Diff summary | 8 files changed, 228 insertions, 8 deletions at snapshot SHA; see [GitHub compare](https://github.com/hamidyaghobi70-beep/infinyx/compare/7c3ea806c8541966a9bf13e2743060117c2402b6...3a583859a64fc61a2d4b899a905cf0f93ad3f3e6) |
| 5 | Complete diff | Available as [GitHub unified diff](https://github.com/hamidyaghobi70-beep/infinyx/compare/7c3ea806c8541966a9bf13e2743060117c2402b6...3a583859a64fc61a2d4b899a905cf0f93ad3f3e6.diff) and [patch](https://github.com/hamidyaghobi70-beep/infinyx/compare/7c3ea806c8541966a9bf13e2743060117c2402b6...3a583859a64fc61a2d4b899a905cf0f93ad3f3e6.patch) |
| 6 | Direct-SHA CI on final target | PENDING — prior run `43711326212` passed on prior target `6a98cff...`; a new run must be checked for the final README-refresh SHA |
| 7 | Dependency audit artifact for final target | PENDING — prior artifact belongs to run `43711326212`, not the new final SHA |
| 8 | Comparison against `main` | At snapshot SHA: 178 ahead / 1 behind; merge base `8500c4098372abb1c29f46ad518e7b87202bd403` |
| 9 | Decision on behind commit | OPEN — `6eb55bd5b22aabd148b1fcb846c083752c49a8cc`, `docs(strategy): add INFINYX master vision and architecture v3.0`; do not cherry-pick without an explicit decision |
| 10 | Capacity contract | `docs/agent-runtime-capacity.md` |
| 11 | Requirement-to-test traceability | Included below |
| 12 | Non-cooperative provider limitation | Included below |
| 13 | Audit exclusions / non-claims | Included below |
| 14 | DeepSeek independent review | NOT PERFORMED |

## Requirement-to-test traceability

| Requirement | Test evidence |
|---|---|
| Synchronous admission and capacity bound | `reserves all capacity synchronously before provider promises settle` in `test/agent/agent-runtime.test.ts` |
| Release after successful provider settlement | `releases all capacity slots after successful provider settlement` in `test/agent/agent-runtime.test.ts` |
| Release after provider error | `releases all capacity slots after provider errors settle` in `test/agent/agent-runtime.test.ts` |
| Caller AbortSignal propagation | `propagates caller AbortSignal to ModelPort` in `test/agent/agent-cancellation.test.ts` |
| Cancellation before provider invocation | `does not invoke ModelPort when shutdown wins before the provider microtask` in `test/agent/agent-cancellation.test.ts` |
| Capacity retention for non-cooperative provider | `does not release capacity for a cancelled non-cooperative provider` in `test/agent/agent-cancellation.test.ts` |
| Capacity release after late settlement | `releases capacity after timed-out providers eventually settle` and `keeps unresolved tasks in the active capacity until their providers settle` in `test/agent/agent-cancellation.test.ts` |

## Type contract refinement

`AgentTaskResult` now uses `AgentCancellationExecutionState` for `cancelled` and `timed_out` results. This excludes `running` at the type level; those results can only be `unresolved` or `settled`. `AgentTaskRecord` continues to use the full `AgentExecutionState`, because a tracked task can legitimately be running.

## V1 operational limitation

A provider may ignore AbortSignal and return a Promise that never settles. Such a task continues to hold its runtime capacity slot indefinitely. If 32 such tasks are active/unresolved, new valid tasks are rejected with `CAPACITY_EXCEEDED`. V1 has no forced termination or independent hard cap for unresolved provider operations. AbortSignal is cooperative only.

## Audit scope and exclusions

Unless separate evidence is added, this package does **not** claim to provide:

- an independent security audit of all dependencies beyond the attached npm audit output;
- a formal proof of JavaScript runtime scheduling or concurrency properties;
- validation of every ModelPort implementation or third-party provider;
- load, soak, fault-injection, or production-scale testing;
- distributed/global concurrency enforcement across processes or runtime instances;
- verification of deployment, release, or production configuration;
- an independent DeepSeek audit (not performed).

## Branch and release guardrails

- Do not merge this branch.
- Do not release or deploy.
- Do not modify `main`.
- Keep unresolved evidence items visibly marked as pending.

## Exact commits after the starting SHA (snapshot through `3a583859...`)

Newest first:

| SHA | Commit message |
|---|---|
| `3a583859a64fc61a2d4b899a905cf0f93ad3f3e6` | fix(agent): align cancellation result state with runtime |
| `a02dced57feb7fbdb9dd8731f87407865e634487` | types(agent): narrow cancellation execution states |
| `6a98cffde48492c52f88413c0c3a592e8186eed0` | docs(agent): update audit evidence status for direct CI |
| `ec1cc9bb3d6010851ee563b668459fce1ea5cdac` | docs(agent): finalize audit index and commit ledger |
| `1094d24301c192f0e61c7fb56b98d514ecabad8e` | test(agent): preserve provider error and output validation cases |
| `6095a1155b4c4526d79789ddc0751c309dd30f39` | docs(agent): record commit history and main comparison evidence |
| `8e8db5ed92fa350541d769f9ff90dd4695fbe364` | ci: run direct verification on agent audit branch |
| `864a5dc8b15b7c808df683168ef6e203c006417e` | docs(agent): add independent audit evidence checklist |
| `966ba9f2f453ea7b1dddff2782f4f46729c0cf80` | docs(agent): clarify execution state and capacity contract |
| `e7300388ee8b8e6d3de55cc83a01adf1baf2e51c` | test(agent): retain capacity for non-cooperative providers |
| `e6cf64fef79e2c545bc745c2b985a4c9c3593952` | test(agent): verify synchronous capacity reservation |
| `a1993d2da5472802192106f13ad4103b309e1ee3` | docs(agent): clarify execution state semantics |
| `93535c26e213ba5ef75f597cf96578b76973e943` | docs(agent): document cooperative ModelPort cancellation |

The README refresh commit is intentionally excluded from its own ledger; record its exact SHA in the external audit cover note.

## Comparison against current `main` (snapshot SHA)

- `main` SHA: `6eb55bd5b22aabd148b1fcb846c083752c49a8cc`
- Merge base: `8500c4098372abb1c29f46ad518e7b87202bd403`
- Branch head: `3a583859a64fc61a2d4b899a905cf0f93ad3f3e6`
- Branch ahead: 178 commits
- Branch behind: 1 commit
- The one commit on `main` not contained in the branch is `6eb55bd5b22aabd148b1fcb846c083752c49a8cc`, titled `docs(strategy): add INFINYX master vision and architecture v3.0`.

Historical comparison against the same `main` SHA: base `9302339b1e78bbc0220297644945f871571bd84f` was 160 ahead / 1 behind; prior target `7c3ea806c8541966a9bf13e2743060117c2402b6` was 165 ahead / 1 behind. The earlier reported value 154 cannot be reconstructed from the available historical main SHA and is not attributed to these commits.
