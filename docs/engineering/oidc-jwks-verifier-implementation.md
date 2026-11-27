# OIDC/JWKS Verification — Implementation Record

- **Status:** Implemented and CI verified.
- **Founder authorization:** Bounded OIDC/JWKS verification phase approved.
- **Branch:** `feat/adr-platform-foundation`
- **Environment:** Provider-neutral code and synthetic tests only; no live identity provider.

## Scope delivered

- Replaced the static-PEM JWT verifier with an asynchronous provider-neutral OIDC discovery/JWKS verifier.
- Discovery is derived only from the configured HTTPS issuer; metadata issuer must exactly match the configured issuer.
- JWKS is fetched only from the HTTPS `jwks_uri` in the trusted discovery document. Redirects are rejected.
- RS256 is the sole accepted signing algorithm in this initial implementation. RSA signing keys must be at least 2048 bits and usable for signature verification.
- Token headers require `alg=RS256`, `typ=JWT`, and a constrained `kid`. Token-supplied `jku`, `x5u`, embedded `jwk`, and `crit` headers are rejected.
- The API token contract is explicit and configuration-bound: exact issuer, API-specific audience, configured access-token `typ` claim, and `azp` in a configured authorized-party allowlist.
- Required claims include `iss`, `aud`, `sub`, `exp`, and `iat`; optional `nbf` is validated when present. A small bounded clock tolerance is configurable.
- OIDC metadata/JWKS requests have bounded timeouts and response sizes. Redirects, malformed documents, duplicate key IDs, unsupported key types, and unusable key sets fail closed.
- JWKS cache lifetime is bounded (default five minutes; configurable up to one hour). Unknown `kid` causes at most one forced refresh per ten seconds; unresolved keys fail closed. Expired-cache refresh failures do not fall back to stale keys.
- Only verifier-created external identity objects receive the private runtime brand. Principal resolution continues to require exact `(issuer, subject)` mapping to an internal user UUID.
- Bearer middleware now supports asynchronous verification and identity resolution while returning a generic 401 response on failures.

## Initial Keycloak token contract

The implementation deliberately requires explicit server configuration for:
- the API audience (not the browser client ID);
- one or more authorized client IDs accepted in `azp`;
- the access-token payload `typ` value (expected to be `Bearer` for the initial Keycloak contract);
- the trusted issuer.

No tenant, role, group, email, phone, or branch claim is used as authorization evidence.

## Tests added/updated

Synthetic RSA key pairs and a deterministic fake discovery/JWKS fetcher cover:
- valid access-token verification and tenant-claim non-authority;
- issuer, audience, token-use, authorized-party, signature, algorithm, `kid`, expiry, `nbf`, and `iat` rejection;
- token-supplied key-location header rejection;
- discovery issuer mismatch and endpoint outage;
- unknown-key rejection and successful bounded JWKS key rotation;
- malformed tokens, oversized tokens, invalid subjects, and invalid verifier configuration;
- asynchronous bearer middleware, identity mapping, and non-forgeable principal behavior.

## Explicit non-goals and remaining gates

- No Keycloak instance, realm, client, endpoint, or configuration was created or changed.
- No live discovery/JWKS endpoint, real provider credentials, BFF, callback, session store, login UI, provisioning, or account linking was added.
- No tenant authorization, membership, RLS, or branch policy was moved into the identity provider.
- No merge, release, or deployment was performed.
- Before a staging connection, the founder must approve concrete non-secret values for issuer, API audience, authorized-party/client IDs, token-type contract, cache policy, and environment/network boundary. Those values must not be committed as secrets.
- Independent security review and staging operational controls remain required.

## Verification

CI verification:
- [GitHub Actions run #45936364957](https://github.com/hamidyaghobi70-beep/infinyx/actions/runs/45936364957) completed successfully on implementation commit `5d06bb371f269d3f80c06137c4a4a50cf10c548a`.
- 11 test files passed; 101 tests passed.
- TypeScript typecheck, migration apply, migration syntax checks, and dependency audit passed; npm audit reported 0 vulnerabilities.
- The CI tests use synthetic signing keys and a fake OIDC discovery/JWKS endpoint; no live identity provider was contacted.
