# ADR-0008: Tenant Membership Lifecycle Administration

- **Status:** Accepted
- **Decision date:** 2026-11-27
- **Decision owner:** INFINYX founder
- **Related decisions:** ADR-0001 (multi-tenancy), ADR-0005 (branch visibility and assignment scope), ADR-0006 (branch assignment administration authorization), ADR-0007 (tenant membership lifecycle)

## Context

ADR-0007 defines the `active`, `suspended`, and `removed` membership states and requires inactive memberships to fail closed. It does not define who may change a member's lifecycle state. These transitions directly affect tenant-wide and branch access and therefore require an explicit authorization boundary.

## Decision

Only members with the current database-backed `owner` or `admin` role may suspend, reactivate, or remove another tenant membership.

The authorization boundary is:

1. The acting principal must have a current membership in the same tenant as the target membership.
2. The actor's role and membership state must be read from the database; client input and JWT role claims are not authorization evidence.
3. The actor must have an active membership and the role must be `owner` or `admin`.
4. The target membership must belong to that same tenant.
5. Authorization checks and the lifecycle mutation must execute in the same tenant-scoped database transaction.
6. `manager`, `editor`, and `viewer` cannot perform lifecycle administration.
7. These permissions do not authorize role changes, ownership transfer, branch-assignment administration beyond ADR-0006, or access to another tenant.
8. A successful suspension or removal immediately denies subsequent tenant and branch access under ADR-0007. Reactivation restores only access allowed by the target's current role and still-valid branch assignments.

The permitted actions are limited to membership lifecycle transitions. They must not silently create memberships, change roles, alter branch assignments, or transfer ownership.

## Audit and security requirements

Every attempted lifecycle administration operation must produce an audit event recording, at minimum:

- tenant identifier;
- actor identifier;
- target member identifier;
- requested action (suspend, reactivate, or remove);
- timestamp;
- outcome.

Audit records must not contain passwords, OTPs, access tokens, or other authentication secrets. Audit retention, immutability, and failure semantics must be defined before implementation.

Authorization failures must fail closed and use generic responses that do not disclose cross-tenant membership existence. The operation must not report success unless both the lifecycle mutation and its required audit handling have completed according to the eventual audit failure policy.

## Explicitly unresolved safeguards

This ADR does not decide the following edge cases; they must be resolved before implementing lifecycle administration:

- whether an actor may suspend or remove their own membership;
- whether an admin may suspend or remove an owner;
- whether the last active owner may be suspended or removed;
- whether an owner may remove or suspend another owner, and what safeguards apply;
- whether removal is reversible or requires a new invitation/membership;
- exact transition rules for repeated or otherwise invalid state transitions;
- audit retention, immutability, and behavior when audit persistence fails.

No implementation may infer permissive behavior for these cases. Until separately decided, affected operations must be rejected or withheld (fail closed).

## Consequences

### Positive

- Lifecycle changes are restricted to tenant-wide administrative roles.
- Authorization is based on current database state and cannot be granted by client-supplied role data.
- Membership changes are tenant-scoped, transaction-safe, and auditable.
- The policy is distinct from branch assignment administration and role management.

### Trade-offs

- The application must enforce lifecycle authorization in the same transaction as each state change.
- Additional safeguards are needed for self-removal and owner continuity before production implementation.
- Audit infrastructure and lifecycle transition validation must exist before the feature is enabled.

## Implementation and verification

This ADR records an accepted policy only. It does not implement a status column, lifecycle repository, mutation endpoint, audit subsystem, or UI.

Required integration tests include owner/admin authorization, denial for manager/editor/viewer, inactive-actor denial, cross-tenant target denial, same-transaction enforcement, audit outcomes, immediate access revocation after suspension/removal, and narrowly scoped access restoration after reactivation. Tests must use the least-privilege application database role with RLS enabled and forced.

The unresolved safeguards above are implementation gates and must be decided before the corresponding operations are implemented.

## Governance

This ADR is accepted on the feature branch only. It does not authorize merge, release, or deployment. Changes to the authorized roles or tenant boundary require renewed founder approval.
