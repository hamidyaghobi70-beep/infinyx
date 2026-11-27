# ADR-0006: Branch Assignment Administration Authorization

- **Status:** Accepted
- **Decision date:** 2026-11-27
- **Decision owner:** INFINYX founder
- **Related decisions:** ADR-0001 (multi-tenancy), ADR-0005 (branch visibility and assignment scope)

## Context

ADR-0005 establishes which tenant roles can see branches but deliberately leaves open who may grant or revoke explicit branch assignments. Assignment administration is security-sensitive: an unauthorized grant can broaden access to business data, while an unauthorized revocation can disrupt legitimate work.

## Decision

Only the `owner` and `admin` roles may create or revoke branch assignments.

The authorization boundary is limited as follows:

- The actor must have a current database-backed membership in the same tenant as the target member and branch.
- The actor's role must be checked against the database, not trusted from a client or JWT role claim.
- The grant/revoke operation must be performed in the same tenant transaction as its authorization checks.
- `manager`, `editor`, and `viewer` cannot grant or revoke branch assignments.
- This decision does not authorize changing tenant roles, transferring ownership, changing tenant membership, or accessing another tenant.
- This decision does not grant additional write permissions over branch business data.
- Any future delegation or broader administrative capability requires a separate founder-approved decision.

## Audit and security requirements

Every assignment grant or revocation must generate an audit event recording, at minimum:

- tenant identifier;
- actor identifier;
- affected member identifier;
- branch identifier;
- action (grant or revoke);
- timestamp;
- outcome.

Audit records must not contain passwords, OTPs, access tokens, or other authentication secrets. Audit retention, immutability, and failure semantics must be defined before the assignment-management feature is implemented.

Authorization failures must fail closed and return a generic response that does not disclose cross-tenant resource existence.

## Consequences

### Positive

- Assignment administration is restricted to the two tenant-wide administrative roles.
- Branch visibility and assignment-management authority remain distinct from business-data write permissions.
- Every assignment change has an explicit actor and an auditable event.

### Trade-offs

- Owners/admins carry responsibility for branch assignment administration.
- The application must enforce role checks inside the same transaction as each assignment mutation.
- An audit event model and assignment lifecycle must be implemented and tested before production use.

## Implementation and verification

This ADR records a policy decision; it does not implement branch tables, assignment repositories, endpoints, or UI.

Integration tests must verify that owner/admin can grant and revoke within their tenant, all other roles are denied, cross-tenant targets are rejected, stale/missing membership is denied, and audit events are recorded. Tests must use the least-privilege application database role with RLS enabled and forced.

## Governance

This ADR is accepted on the feature branch only. It does not authorize merge, release, or deployment. Changes to the authorized grant/revoke roles require renewed founder approval.
