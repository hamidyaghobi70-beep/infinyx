# Implementation Authorization Record

- **Recorded:** 2026-11-27
- **Status:** Implementation authorized within the bounded scope below.
- **Applies to:** `feat/adr-platform-foundation` only.

## Authorization evidence

The repository owner explicitly approved implementation work in the project conversation after the Master Strategy V3 document had been drafted. The approval includes recording an implementation authorization in the repository and continuing implementation in small, reviewable steps.

This record documents that later, explicit approval. It does not silently rewrite the historical authorization status in the Master Strategy V3 document.

## Authorized scope

- Small, reviewable implementation changes aligned with accepted ADRs.
- Security-focused tests and CI improvements.
- PostgreSQL persistence foundation, including the driver, migration tooling, tenant transaction boundary, DAL, and integration tests, subject to the constraints below.
- Documentation needed to keep design, implementation, and verification status distinct.

## Constraints

1. Work stays on `feat/adr-platform-foundation`; do not modify `main`.
2. No merge, release, production deployment, or public launch is authorized by this record.
3. Do not introduce production credentials, real customer data, or live external integrations.
4. Tenant isolation is not considered implemented until real PostgreSQL RLS integration tests pass using the least-privilege application role.
5. Never claim a feature is tested or verified without recorded test evidence.
6. Changes with material cost, irreversible effects, external publication, or production access require separate explicit approval.
7. If a security invariant cannot be established, fail closed and document the limitation rather than bypassing it.

## Relationship to the Master Strategy

The Master Strategy V3 statement `Implementation Authorization: NOT GRANTED` reflects the state when that document was authored. This later record supersedes that status only for the bounded implementation scope above. Its merge and release restrictions remain unchanged.

## Current implementation state

- Reproducible dependency installation: IMPLEMENTED; `npm ci` passed in GitHub Actions.
- JWT authenticated-principal foundation: IMPLEMENTED; 25 unit tests passed in CI.
- PostgreSQL target and tenant-isolation contract: DESIGNED in ADR-0002 and ADR-0003.
- PostgreSQL driver, migration, and tenant transaction decisions: DESIGNED in ADR-0004.
- PostgreSQL runtime, schema, RLS policies, and real database integration tests: NOT IMPLEMENTED.
- Merge and release: NOT AUTHORIZED.