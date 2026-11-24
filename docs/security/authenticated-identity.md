# Authenticated identity boundary

Status: implemented as a configurable RS256 bearer-token verifier; not production-enabled until the deployment owner supplies the real identity-provider trust configuration.

## OIDC/JWKS key resolver baseline

A bounded JWKS resolver is now available in `src/core/jwks-key-resolver.ts`. It requires an operator-supplied HTTPS endpoint, refuses redirects and credential-bearing URLs, enforces a streaming response-size limit and request timeout, rejects duplicate `kid` values, accepts only RSA signing keys marked for RS256 with at least 2048-bit modulus, caches keys for a bounded interval, and refreshes once when an unknown `kid` is requested. Unit tests cover caching, key rotation, unsuitable keys, insecure URLs, and endpoint failures.

The server can now use this resolver through an asynchronous RS256 verifier and bearer middleware. Configure `AUTH_ISSUER`, `AUTH_AUDIENCE`, and exactly one of `AUTH_JWKS_URL` or `AUTH_PUBLIC_KEY_PEM`. The JWKS URL must be the trusted HTTPS signing-keys endpoint for the configured issuer; it is never discovered from an untrusted token. Unknown `kid` values trigger a bounded refresh. Keycloak is the preferred deployment target, but no realm, issuer, audience, endpoint, or signing key has been invented or configured.

## Runtime configuration

Set all three environment variables together:
- `AUTH_ISSUER`: exact JWT `iss` value expected from the trusted identity provider.
- `AUTH_AUDIENCE`: this API's registered audience value.
- `AUTH_PUBLIC_KEY_PEM`: trusted RSA public key in PEM format (literal newlines or escaped `\\n` are accepted).

The server refuses partial configuration at startup. With all three values configured, `GET /v1/identity` is mounted and requires `Authorization: Bearer <JWT>`. Without the configuration, the route is not mounted. Private signing keys must remain at the identity provider; never put them in this repository or application environment.

## Token contract

The verifiers accept RS256 only, require RSA keys of at least 2048 bits, validate canonical unpadded base64url segments, and reject unsupported JOSE critical/unencoded-payload header extensions. JWKS mode additionally requires a valid `kid` and resolves it only from the configured trusted JWKS endpoint. It also requires:
- exact issuer and expected audience (string or array)
- non-empty `sub` and `tenant_id`
- numeric `exp`, with a bounded five-second default clock tolerance
- valid `nbf` when present

It rejects malformed tokens, unsupported algorithms, invalid signatures, expired/not-yet-valid tokens and malformed identity claims with the same generic 401 response. No token or signature details are returned to callers.

## Trusted memory binding

`createPrincipalMemoryScope` accepts only a principal object issued by this process's verifier (tracked by a private WeakSet), then derives `tenantId` from the signed `tenant_id` claim and `actorId` from signed `sub`. A module cannot supply or override either identity field. The request-scoped `createAuthenticatedMemorySession` helper uses this verified-principal check to create a fresh `GuardedMemoryPort` with tenant and actor values derived from signed claims. Do not cache the resulting capability across requests or accept caller-supplied tenant/actor identifiers. Core module contexts have module lifetime, so they must not hold a user-specific singleton memory session. The helper is an exported boundary, not yet a live HTTP memory workload or PostgreSQL deployment.

## Explicit remaining integration gate

This repository does not identify which identity provider the owner operates, its issuer URL, API audience, or active public signing key. Those deployment-specific trust anchors cannot safely be guessed. Until the owner configures the actual values and verifies a token issued for this API, authenticated identity is not considered production-connected. The current server has no user-facing memory workload and does not wire persistent PostgreSQL storage or activate Agent runtime.
