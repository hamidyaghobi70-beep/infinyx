# INFINYX Internal Alpha — Release Readiness Gate

**Assessment date:** 2026-11-15  
**Disposition:** NOT READY — candidate assembly and technical acceptance are incomplete.  
**Target:** controlled Internal Alpha only; not a public beta, production release, or security-certified build.

## 1. Purpose and non-negotiable boundary

This gate defines the minimum evidence required before an Internal Alpha candidate can be approved for controlled evaluation.

Until every applicable gate is closed:
- Do not tag, publish, distribute, or deploy a release candidate.
- Do not expose the runtime to the public internet.
- Do not process real user data, secrets, financial activity, or other sensitive workloads.
- Keep Agent execution, external Tool execution, wallet/private-key operations, signing, asset transfer, and unrestricted outbound access disabled.
- Preserve the default-deny policy.

An Internal Alpha is a restricted engineering evaluation, not evidence of production readiness.

## 2. Repository facts at assessment time

- The repository default branch is `main` at `8500c4098372abb1c29f46ad518e7b87202bd403`; its recursive tree contains only `README.md`.
- The executable core is on `integration/infinyx-core-runtime-v1` at `683074174c140ee67620ee98ba5d55ecfbdef006`.
- The integration branch contains the Node.js/TypeScript application, tests, lockfile, and CI workflows.
- The repository is public. The existing `release/private-alpha-v0.1.0` branch is 90 commits ahead of `main`, and its PR targets `main`. This is not an acceptable basis for claiming a private distribution channel.
- No GitHub Release is currently recorded.
- At the assessment snapshot, 19 pull requests were open and all were Draft. A passing PR workflow is not equivalent to an accepted, integrated release candidate.

## 3. Candidate assembly gate — BLOCKED

A single, traceable candidate must be assembled from an explicitly selected integration baseline. Do not combine unrelated branches by guesswork.

The current dependency chain includes:
- PR #7: core runtime integration; still Draft and documents unresolved protected-operation drain, invocation-correlation, process-termination, and evaluator-diagnostic findings.
- PR #18: protected-operation hardening; still Draft, based on the integration branch. Its description says the complete ENG002 57-case acceptance matrix is not established and the 30-second default remains provisional pending representative-load benchmarks.
- PRs #19–#24: a stacked policy-hardening sequence on separate branches.
- PR #27: closed without merge.
- PR #34: clean hard-termination follow-up on the policy branch; exact-head CI run 43648179036 passed all four jobs, but the PR remains Draft and is not part of the integration branch.
- PR #28: descendant-containment design documentation; it does not itself implement OS-level process-tree containment.

**Acceptance evidence required**
- One selected candidate branch and exact base/head SHAs.
- A dependency map proving each included change is based on the accepted predecessor.
- No unresolved conflicts or stale-base assumptions.
- Exact-head CI after the final candidate assembly.
- A changed-file and commit review confirming that only approved scope is included.

## 4. Runtime and policy gate — BLOCKED

Before candidate acceptance:
- Resolve the four protected-operation and policy findings recorded in PR #7.
- Verify that shutdown drains admitted operations before dependent module cleanup.
- Verify unique per-invocation correlation identifiers.
- Verify termination escalation and the unresolved-capacity behavior on the final candidate.
- Verify evaluator diagnostics cannot disclose evaluator-controlled messages or stderr.
- Verify output-budget, input-boundary, deadline, candidate-freeze, and terminal-commitment behavior on the exact assembled candidate.
- Record any remaining limitation explicitly; a timeout response must not be represented as cancellation of underlying work.

The CI success recorded for PR #34 is useful evidence for that PR's exact head only. It does not close the entire integration or release gate.

## 5. Memory and data gate — RESTRICTED / NOT PERSISTENT

The current integration tree provides a guarded in-memory reference store, not durable persistence.

For this Internal Alpha:
- Use synthetic, non-sensitive test data only.
- Do not promise durable memory, recovery after restart, backup, or deletion guarantees.
- Do not store secrets or production credentials.
- Keep the absence of a persistence adapter explicit in user-facing documentation.

Durable storage, encryption/key ownership and rotation, retention/deletion, backup/restore, and durable audit require their own accepted design and implementation before any sensitive-data use.

## 6. Identity and network gate — NOT IMPLEMENTED

The security baseline records authentication, authorization, trusted identity derivation, tenant isolation, SSRF-safe egress controls, and production secret management as unimplemented or unverified.

Therefore:
- Bind only to loopback or use an explicitly isolated development environment.
- Do not expose the server to the public internet.
- Do not treat caller-supplied actor identifiers as authenticated identity.
- Do not claim tenant isolation or production access control.
- Do not connect real external tools or credentials.

These are hard restrictions, not optional launch polish.

## 7. Test and supply-chain gate — PARTIALLY EVIDENCED

Required for the exact final candidate:
1. `npm ci`
2. `npm run typecheck`
3. `npm run build`
4. `npm test`
5. `npm run test:process`
6. Runtime smoke test for the documented loopback health endpoint.
7. Ubuntu, macOS, and Windows CI results, with platform-specific skips explained.
8. Dependency audit results and explicit review of any advisories.

The CI workflow uses `npm audit --audit-level=high`; passing that threshold must not be described as proof that no lower-severity advisories exist.

CI evidence from a parent branch or an earlier SHA does not satisfy this gate. The complete candidate must receive a fresh exact-head run after assembly.

## 8. Operational gate — NOT YET ACCEPTED

Before Internal Alpha approval, document and test:
- Startup, health/liveness semantics, and graceful shutdown.
- Resource limits and behavior when child processes remain unresolved.
- Log redaction and the boundary between diagnostic logs and audit records.
- Recovery/restart expectations and known data-loss behavior.
- A minimal operator runbook and a way to report/block a faulty candidate.

The health endpoint is a liveness probe, not proof of readiness or security.

## 9. Governance gate — REQUIRED

- Technical acceptance must identify the exact candidate SHA and unresolved risks.
- Independent review must be performed by the designated reviewer; an implementation author's own review or a green CI run is not independent assurance.
- No reviewer approval may be fabricated or inferred from silence.
- Merge authorization remains separate from release authorization.
- The Founder & Owner must separately authorize each release and each deployment.
- This document and a Draft PR do not authorize merge, tag, release, or deployment.

## 10. Final decision checklist

- [ ] Candidate branch and exact SHAs selected and recorded.
- [ ] Required runtime/policy changes integrated in dependency order.
- [ ] Four PR #7 findings resolved or explicitly dispositioned by the authorized technical decision-maker.
- [ ] ENG002 acceptance matrix completed or formally scoped with accepted residual risks.
- [ ] Representative-load benchmark completed for the provisional 30-second drain default.
- [ ] Exact-head CI passes on all supported platforms.
- [ ] Dependency audit reviewed; no unaccepted high/critical findings.
- [ ] Memory, identity, network, and data restrictions documented and enforced.
- [ ] Loopback/isolated runtime smoke test and operator runbook verified.
- [ ] Independent review of the exact candidate completed.
- [ ] Separate Founder authorization recorded before any release or deployment.

**Current decision: NOT READY.** The next engineering action is to reconcile the candidate dependency chain and resolve the integration blockers. Do not use the old `release/private-alpha-v0.1.0` branch as a release source without a new, complete review.
