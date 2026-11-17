# INFINYX Merge and Change Authority Policy

**Status:** Project governance agreement  
**Applies to:** Repository changes, pull-request review, merge, release, and deployment decisions in `hamidyaghobi70-beep/infinyx`.

## Roles and decision rights

| Role | Authority |
|---|---|
| **Hamid — Founder & Owner** | Project founder and owner. Retains approval authority for every release and deployment. |
| **Hanieh — Project Leader** | Owns the technical readiness decision and issues the explicit instruction to merge a specific pull request and exact head revision after the acceptance criteria are met. |
| **Parvaneh — GitHub Operator** | Executes GitHub operations within this policy and performs a merge only after Hanieh's explicit instruction for the specific pull request and exact head revision. |

These role assignments record the project agreement. They do not grant repository permissions automatically; GitHub access controls remain independently enforced.

## Merge policy

1. **No merge before technical acceptance.** A pull request must not be merged until its applicable technical acceptance criteria have been met and the evidence has been reviewed against the exact head commit.
2. **Project Leader decision and instruction.** Hanieh is responsible for determining technical readiness, deciding the merge timing, and issuing the explicit merge instruction for the specific pull request and exact head revision.
3. **GitHub execution.** Parvaneh performs the GitHub merge operation only after receiving that explicit instruction from Hanieh.
4. **No inferred approval.** A successful CI run, a draft-to-ready status change, elapsed time, or a general discussion does not by itself authorize a merge.
5. **No bypass.** Technical gates, required reviews, repository protections, and unresolved blocking findings must not be bypassed.

## Release and deployment policy

1. Release and deployment are separate decisions from merge.
2. **Each release and each deployment requires separate, explicit approval from Hamid (Founder & Owner).**
3. Merge approval or Hanieh's readiness decision does not imply release or deployment approval.
4. Parvaneh must not initiate a release or deployment without the applicable separate approval from Hamid.

## Operational boundaries

- Keep work isolated on dedicated branches and preserve the agreed pull-request review state.
- PR #3 was merged into `fix/core-engine-shutdown-v6` at merge commit `fe36d2d4ea9dd91cf0c3090628ff6527c80d5ca5`; its target was not `main`.
- The PR #3 merge did not change `main`; no Release or Deployment was performed as part of that merge.
- Do not enable Agent or Tool Execution under this agreement; those capabilities remain out of scope unless separately reviewed and authorized.
- Record the relevant pull request, head SHA, technical evidence, decision, and operator action so that the authorization is auditable.
- If the required decision or approval is ambiguous, stop and request clarification rather than infer permission.

## Scope of this policy

This document records decision rights and operational authorization. It does not replace stage-specific engineering acceptance criteria, security review, branch protection, or GitHub permissions. More restrictive repository or security controls continue to apply.
