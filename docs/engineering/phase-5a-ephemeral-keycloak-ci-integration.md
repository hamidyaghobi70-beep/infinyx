# Phase 5A — Ephemeral Keycloak CI Integration Record

**Status:** Implemented; GitHub Actions CI run #45945498416 completed successfully.  
**Environment:** GitHub Actions job-local Docker container; no public endpoint.  
**Keycloak image:** `quay.io/keycloak/keycloak:26.3.3`.

## Objective

Exercise the existing Web BFF OIDC discovery boundary against a real Keycloak server without purchasing a domain, provisioning a VM, exposing a service publicly, or storing persistent identity-provider infrastructure.

## CI topology

- GitHub Actions starts an isolated Keycloak container inside the existing CI job.
- A one-day self-signed certificate is generated for `localhost` with DNS and loopback IP SANs.
- The certificate is mounted read-only into the container and trusted only by the test job through `NODE_EXTRA_CA_CERTS`.
- Keycloak serves HTTPS on the job-local loopback port 8443.
- The `infinyx-ci` realm is imported from a repository fixture containing one confidential test client. Direct Access Grants and implicit flow are disabled.
- The client secret and bootstrap administrator password are synthetic CI-only values; they are not production credentials and must never be reused.
- The integration test calls the production `discoverOidcClient` function, verifies issuer and HTTPS endpoint metadata, builds the authorization URL, and fetches the realm JWKS over trusted TLS.
- The Keycloak container is removed at the end of the job, including on failure.

## Security boundaries

- No DNS record, purchased domain, public tunnel, inbound public endpoint, or persistent server is created.
- No production realm, user, client, secret, or database is touched.
- The self-signed certificate is scoped to this job and is not trusted globally.
- HTTPS validation in application code remains strict; no localhost HTTP exception or TLS verification bypass is introduced.
- The test realm is not a production configuration template.
- This test verifies real provider discovery, authorization endpoint construction, and JWKS reachability. It does **not** yet prove a full interactive browser login, authorization-code callback, token exchange, refresh, or logout against Keycloak.

## Reproduction

The workflow performs the following operations automatically:

1. Generate a short-lived localhost TLS certificate.
2. Start the pinned Keycloak container with the isolated realm fixture.
3. Wait for the realm's OIDC discovery document over HTTPS.
4. Run `npm run test:keycloak`.
5. Remove the container regardless of test outcome.

## Cost and limitations

No domain, paid hosting, or paid Keycloak service is required. GitHub Actions usage remains subject to the repository/account's included minutes and usage limits; zero cost is not guaranteed for every account or usage pattern.

The ephemeral container and realm disappear after the CI job. This is an integration-test environment, not persistent staging and not suitable for real users.

## Verified CI evidence

- Workflow run: [#45945498416](https://github.com/hamidyaghobi70-beep/infinyx/actions/runs/45945498416).
- Run conclusion: `completed / success` on branch `feat/adr-platform-foundation`, commit `13e89a9f1f4e775b82d03612006e2ac48b3ad11d`.
- All 21 job steps completed successfully, including TLS certificate creation, isolated Keycloak startup, database migrations, typecheck, Web BFF build, unit/PostgreSQL integration tests, live Keycloak OIDC discovery/JWKS verification over HTTPS, and container cleanup.
- The test contacted a real ephemeral Keycloak 26.3.3 instance inside the CI job. It verified discovery metadata, HTTPS endpoints, authorization URL construction, and JWKS reachability.
- This is not a full browser login, authorization-code callback/token exchange, refresh/logout, persistent staging, or production verification.

## Governance

All changes are limited to `feat/adr-platform-foundation`. The existing draft PR remains unmerged. No changes are made to `main`; no release, public deployment, or production configuration is performed.
