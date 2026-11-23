# Authenticated identity boundary

Status: implemented as a configurable RS256 bearer-token verifier; not production-enabled until the deployment owner supplies the real identity-provider trust configuration.

## Runtime configuration

Set all three environment variables together:
- `AUTH_ISSUER`: exact JWT `iss` value expected from the trusted identity provider.
- `AUTH_AUDIENCE`: this API's registered audience value.
- `AUTH_PUBLIC_KEY_PEM`: trusted RSA public key in PEM format (literal newlines or escaped `\\n` are accepted).

The server refuses partial configuration at startup. With all three values configured, `GET /v1/identity` is mounted and requires `Authorization: Bearer <JWT>`. Without the configuration, the route is not mounted. Private signing keys must remain at the identity provider; never put them in this repository or application environment.

## Token contract

The verifier accepts RS256 only, requires an RSA public key of at least 2048 bits, validates canonical unpadded base64url segments, and rejects unsupported JOSE critical/unencoded-payload header extensions. It also requires:
- exact issuer and expected audience (string or array)
- non-empty `sub` and `tenant_id`
- numeric `exp`, with a bounded five-second default clock tolerance
- valid `nbf` when present

It rejects malformed tokens, unsupported algorithms, invalid signatures, expired/not-yet-valid tokens and malformed identity claims with the same generic 401 response. No token or signature details are returned to callers.

## Trusted memory binding

`createPrincipalMemoryScope` accepts only a principal object issued by this process's verifier (tracked by a private WeakSet), then derives `tenantId` from the signed `tenant_id` claim and `actorId` from signed `sub`. A module cannot supply or override either identity field. The resulting scope must be used by the trusted composition root when it creates a module's `GuardedMemoryPort`.

## Explicit remaining integration gate

This repository does not identify which identity provider the owner operates, its issuer URL, API audience, or active public signing key. Those deployment-specific trust anchors cannot safely be guessed. Until the owner configures the actual values and verifies a token issued for this API, authenticated identity is not considered production-connected. The current server has no user-facing memory workload and does not wire persistent PostgreSQL storage or activate Agent runtime.
