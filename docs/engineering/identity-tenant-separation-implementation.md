# Identity and Tenant Separation — Implementation Record

- **Status:** Implemented on the feature branch; CI verified
- **Implementation commit:** `b22078a96c42ed38e73a610c73ee24550e7cf060`
- **CI run:** [#45935082596](https://github.com/hamidyaghobi70-beep/infinyx/actions/runs/45935082596)
- **Related:** ADR-0011, Keycloak Staging Integration Design, Keycloak Staging Implementation Plan
- **Branch:** `feat/adr-platform-foundation`

## 1. Delivered

### Provider identity and internal identity are separate

- JWT verification produces a trusted `VerifiedExternalIdentity` containing issuer, opaque subject, audience, and expiry.
- Tenant, role, branch, and group claims are not copied into the verified identity and are not treated as authorization evidence.
- `createAuthenticatedPrincipalResolver` maps the exact `(issuer, subject)` pair through an injected INFINYX-owned identity-directory lookup.
- Only a successful mapping to a valid internal UUID produces an `AuthenticatedPrincipal`.
- Unknown identities fail closed. No email/phone equality matching or implicit account linking is performed.
- Runtime trust boundaries remain non-forgeable through module-private `WeakSet` checks.

### Tenant selection and authorization are separate from authentication

- `withTenantTransaction` now requires a separate tenant selector.
- It establishes transaction-local RLS context, then resolves an active membership using `internal_user_id`.
- The active membership row is locked with `FOR SHARE` for the duration of the protected transaction.
- Missing, suspended, removed, malformed, or unrecognized memberships fail closed before the repository callback runs.
- The tenant context is stored against the transaction handle in a private `WeakMap`, not on the authenticated principal.
- The context is removed when the transaction ends. It cannot be reused with another transaction or principal.
- Membership helpers, tenant repository access, invitation administration, and membership lifecycle operations consume this transaction-bound context.

### Memory scopes

- Personal memory scope is keyed by the stable internal `userId` and has no tenant dimension.
- Tenant memory scope can be derived only from a live, authorized tenant transaction.
- Business/project-specific memory scopes remain deferred until their resource authorization boundaries exist; they must not be inferred from a tenant selector alone.

### Membership mapping migration

Migration `005_internal_user_membership_mapping.cjs`:
- Adds nullable `tenant_memberships.internal_user_id` with a restrictive FK to `users(id)`.
- Adds consistency validation between the legacy `user_id` string and the internal UUID for newly mapped records.
- Adds unique/history indexes for mapped internal-user membership generations.
- Extends the database lifecycle trigger so the internal-user mapping cannot be changed through ordinary membership updates.
- Does not infer or automatically backfill legacy provider-subject values.

Legacy membership rows with `internal_user_id IS NULL` do not authorize tenant access. A later backfill requires a separately reviewed, exact identity mapping; matching by email or phone is not acceptable. The down migration refuses rollback if mapped membership data exists.

### Invitation and identity flows

- Invitation creation and revocation use the internal user ID for actor attribution and mapped invitee membership checks.
- Invitation acceptance remains a distinct token-hash tenant-resolution path; it does not require a pre-existing tenant membership.
- Acceptance requires a previously mapped authenticated internal user and a provider assertion matching the authenticated issuer, subject, and audience.
- New accepted memberships store both the legacy string representation and the explicit UUID mapping.
- Global identity-directory integration tests now use a global identity transaction rather than a tenant transaction.

## 2. Verification evidence

CI run [#45935082596](https://github.com/hamidyaghobi70-beep/infinyx/actions/runs/45935082596) completed successfully on the implementation commit.

- TypeScript typecheck: passed
- Unit and PostgreSQL integration tests: 11 test files, 98 tests passed
- PostgreSQL migrations and migration syntax checks: passed
- Dependency audit: 0 reported vulnerabilities
- Least-privilege application role and tenant RLS integration checks: passed

## 3. Explicit limitations and deferred work

- The JWT verifier remains a static-PEM RS256 verifier. OIDC discovery, JWKS caching/rotation, token-use validation, and provider integration are not implemented here.
- Keycloak is selected architecturally but is not configured or running.
- No BFF routes, login callback, server-side session store, or production authentication wiring are implemented.
- The principal resolver is an injected boundary; the application-level adapter that calls the INFINYX identity directory must be wired as part of the later provider integration.
- Legacy memberships are not automatically backfilled. They remain inaccessible through the new membership boundary until exact mapping is performed through an approved migration.
- No real-user migration, production credentials, live email/SMS delivery, infrastructure provisioning, merge, release, or deployment is included.
- Branch assignment authorization remains a separate future boundary; active tenant membership alone does not grant branch-scoped access where branch assignment is required.

## 4. Governance

All changes remain on `feat/adr-platform-foundation`. `main` is unchanged. PR #68 remains draft. No merge, release, or deployment was performed.
