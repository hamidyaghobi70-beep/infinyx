# INFINYX Agent V1 — Independent Audit Evidence Package

**Status: draft / evidence incomplete.** This directory is an evidence index, not a claim that all checks have passed. Replace every `PENDING` entry with an attached artifact or an explicit `NOT AVAILABLE` / `OUT OF SCOPE` statement before submitting the package to an independent auditor.

## Target identity

- Target branch: `integration/infinyx-agent-v1-audit-hardening`
- Target SHA: `PENDING — record the resulting commit SHA after all changes are committed`
- Starting SHA: `7c3ea806c8541966a9bf13e2743060117c2402b6`
- Diff base SHA: `PENDING — select and record the exact base`
- `main` SHA at comparison time: `PENDING — capture at audit time`

## Required evidence

| # | Evidence | Status / required artifact |
|---:|---|---|
| 1 | Target SHA (not a temporary PR merge commit) | PENDING |
| 2 | Exact diff-base SHA | PENDING |
| 3 | Full `git log --oneline BASE..TARGET` output | PENDING — include every commit, not an assumed count |
| 4 | `git diff BASE..TARGET --stat` output | PENDING |
| 5 | Complete `git diff BASE..TARGET` | PENDING |
| 6 | Raw CI logs run directly against TARGET: macOS, Windows, Ubuntu, security audit | PENDING |
| 7 | `npm audit --json` output from TARGET | PENDING |
| 8 | Comparison against `main`: ahead/behind, merge-base, current main SHA, and exact behind commit | PENDING |
| 9 | Decision on commit `6eb55bd5b22aabd148b1fcb846c083752c49a8cc` (reported documentation commit) | OPEN — do not assume it is included or required |
| 10 | Capacity contract at the exact target SHA | PENDING |
| 11 | Requirement-to-test traceability table | PENDING |
| 12 | V1 limitation statement: non-cooperative provider and no forced termination | INCLUDED IN `docs/agent-runtime-capacity.md`; verify at target SHA |
| 13 | Explicit audit exclusions / non-claims | INCLUDED BELOW |
| 14 | Statement distinguishing prior PR merge-commit CI from direct-SHA CI | INCLUDED BELOW; direct-SHA run still PENDING |

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

The previously reported successful workflow run `43709839485` checked out a temporary PR merge commit (`f67de10`), not the target commit directly. It must not be described as direct-target-SHA CI. Direct-SHA CI evidence for the target listed above is still PENDING.

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
