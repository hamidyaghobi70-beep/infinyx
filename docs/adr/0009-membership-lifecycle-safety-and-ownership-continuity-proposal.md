# ADR-0009 Proposal: Membership Lifecycle Safety and Ownership Continuity

- **Status:** Proposed — founder decision required
- **Date prepared:** 2026-11-27
- **Decision owner:** INFINYX founder
- **Related decisions:** ADR-0006, ADR-0007, ADR-0008

## 1. Purpose

ADR-0008 limits membership lifecycle administration to active, database-verified owners and admins. Before implementing those operations, the platform needs explicit safeguards for self-removal, owner accounts, last-owner continuity, reversibility, and audit failures.

This document is a proposal for founder review. It is not an accepted policy and does not authorize implementation.

## 2. Recommended safeguards for approval

### 2.1 Self-suspension and self-removal

**Recommendation:** An actor may not suspend or remove their own membership through the administrative lifecycle API.

A user who wants to leave a tenant should use a separate leave-membership workflow. If the user is the last active owner, leaving must first require a completed ownership transfer to another eligible member.

Rationale: prevents accidental loss of the tenant's administrative control and avoids self-removal bypassing ownership continuity safeguards.

### 2.2 Admin actions against owners

**Recommendation:** An `admin` may not suspend or remove any `owner`.

Only an owner may initiate an owner-level membership change, subject to the owner continuity and multi-owner safeguards below. Admins may continue to manage non-owner memberships.

Rationale: keeps ownership authority distinct from delegated administration.

### 2.3 Owner-to-owner actions

**Recommendation:** Do not allow the ordinary member lifecycle endpoint to suspend or remove another owner. Owner role changes, ownership transfer, and owner departure should use a separate ownership-governance workflow with explicit confirmation and audit.

Rationale: lifecycle administration should not become an implicit ownership-transfer mechanism.

### 2.4 Last active owner protection

**Recommendation:** The system must never suspend or remove the last active owner of a tenant.

Before an owner departure or ownership change can complete, another eligible active member must first become an owner through a separately authorized ownership-transfer flow. The check and mutation must be serialized transactionally to prevent concurrent operations from removing all active owners.

Rationale: every tenant must retain at least one active owner capable of managing it.

### 2.5 Removal reversibility

**Recommendation:** Treat `removed` as terminal. Do not reactivate a removed membership. If the person is invited again, create a new membership only through a fresh invitation/acceptance process, with a new lifecycle record or generation identifier and preserved historical audit records.

Suspension remains reversible through the `suspended` → `active` transition.

Rationale: prevents stale assignments or old credentials from silently restoring prior access.

### 2.6 Allowed transitions

**Recommendation:** Enforce only these transitions:

| Current state | Requested state | Recommendation |
|---|---|---|
| active | suspended | Allow if actor and ownership safeguards pass |
| active | removed | Allow if actor and ownership safeguards pass |
| suspended | active | Allow if actor and ownership safeguards pass |
| suspended | removed | Allow if actor and ownership safeguards pass |
| removed | any state | Deny; use a fresh invitation for a new membership |
| same state | same state | Return a stable no-op result; do not create duplicate transition events |

All checks must use current database state in the same transaction as the mutation.

### 2.7 Audit write failure

**Recommendation:** Make the lifecycle state change and its audit event atomic in one database transaction. If the audit event cannot be persisted, roll back the state change. Never report success when the required audit record is absent.

Audit events should record tenant, actor, target, previous state, requested/new state, timestamp, outcome, and a correlation identifier. Do not record credentials, OTPs, access tokens, or unnecessary personal data.

## 3. Additional implementation safeguards

- Use row-level locking or an equivalent serialization strategy for owner-count and membership-transition checks.
- Re-check actor and target membership state/roles after acquiring the relevant locks.
- Prevent cross-tenant targets using tenant-scoped predicates and existing RLS/DAL controls.
- Ensure all protected reads and mutations share one tenant transaction.
- Make retries safe and prevent duplicate audit events using a stable operation/correlation identifier.
- Fail closed on missing, inconsistent, or ambiguous membership records.
- Return generic authorization errors that do not disclose cross-tenant resource existence.

## 4. Required verification

Before enabling lifecycle administration, integration tests should cover:

1. Admin cannot suspend or remove an owner.
2. Owner-to-owner lifecycle changes are denied by the ordinary lifecycle endpoint.
3. Self-suspension and self-removal are denied through the administrative endpoint.
4. The last active owner cannot be suspended or removed.
5. Ownership transfer must complete before an owner departure.
6. Concurrent requests cannot remove or suspend all active owners.
7. Removed membership cannot be reactivated.
8. A fresh invitation creates a new membership lifecycle and does not revive old assignments.
9. Suspension/reactivation follows the approved transition matrix.
10. Same-state retries are safe and do not duplicate transition events.
11. Audit failure rolls back the lifecycle mutation.
12. Cross-tenant and inactive-actor operations fail closed.
13. All checks use the same transaction and least-privilege database role with RLS enabled and forced.

## 5. Founder decisions requested

The founder is asked to approve, reject, or amend each recommendation in Section 2. Until then:

- ADR-0008 remains the accepted high-level authorization policy.
- The edge cases listed here remain unresolved implementation gates.
- No membership lifecycle schema, repository, endpoint, or UI should be implemented based on this proposal alone.
- No merge, release, or deployment is authorized.

## 6. Governance

This proposal is recorded on `feat/adr-platform-foundation` for review only. Acceptance requires explicit founder approval and a subsequent status/decision update. The `main` branch remains unchanged.
