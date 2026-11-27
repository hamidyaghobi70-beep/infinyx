# Web BFF and Server-Side Session Implementation Record

**Status:** Implemented on feat/adr-platform-foundation; CI verified.  
**Scope:** Phase 4 of the Keycloak Staging Implementation Plan.  
**Runtime:** Node.js 22, built-in node:http, PostgreSQL, openid-client 6.9.1.

## 1. Implemented architecture

The browser-facing authentication boundary is a Node.js Backend-for-Frontend (BFF). The browser receives host-only session cookies and a CSRF token from the session endpoint; OAuth access tokens, refresh tokens, and ID tokens remain server-side.

The BFF does not make tenant claims authoritative. Its session identifies an internal INFINYX user only. Future tenant-scoped operations must continue to resolve the requested tenant and branch against current INFINYX membership and authorization data.

## 2. HTTP routes

| Method | Route | Behavior |
|---|---|---|
| GET | /auth/login | Starts OIDC Authorization Code + PKCE |
| GET | /auth/callback | Validates callback and creates a server-side session |
| GET | /api/session | Returns authentication state, internal user ID, and CSRF token; never returns OAuth tokens |
| POST | /auth/logout | Requires exact Origin and synchronizer CSRF token, then revokes local session |

The HTTP transport applies no-store, content-type, framing, referrer, cross-origin resource, and restrictive content-security headers. It does not enable CORS. Unknown routes and unsupported methods fail closed.

## 3. OIDC login

- Uses openid-client 6.9.1 with a confidential client.
- Authorization Code Flow with PKCE S256, random state, and random nonce.
- State, nonce, and PKCE verifier are bound to the initiating browser through a short-lived host-only login cookie and an encrypted, one-time PostgreSQL transaction.
- Callback transaction consumption is atomic and single-use.
- The callback URL is reconstructed from the configured redirect URI, not the incoming Host header.
- Redirect URI is fixed to the configured same-origin /auth/callback; post-login destination is fixed to /, not caller-controlled.
- ID token validation is performed by the OIDC client library, including signature and protocol claim checks; the expected nonce and state are supplied explicitly.
- The authorization-server issuer and discovered endpoints must be HTTPS and match the configured issuer. Provider requests reject redirects, use a five-second timeout, and cap response bodies.
- External identity mapping uses the exact (issuer, subject) pair in user_external_identities. Unknown identities fail closed. No email/phone-based linking or automatic account provisioning is performed.

The stage-3 API access-token verifier remains a separate boundary; it is not reused as an ID-token verifier.

## 4. Cookies, sessions, and CSRF

Session cookies use the __Host- prefix with Secure, HttpOnly, Path=/, no Domain, and SameSite=Lax. The login transaction cookie is short-lived and has the same host-only security properties.

- Session IDs and CSRF tokens are 256-bit random values; only their SHA-256 hashes are stored in their dedicated database columns.
- The encrypted session secret bundle contains provider tokens and the CSRF token, protected with AES-256-GCM and purpose-specific associated data.
- Pending login transaction payloads (PKCE verifier and nonce) are separately AES-256-GCM encrypted.
- A new session ID is created after successful login; any prior browser session is revoked.
- Idle lifetime: 30 minutes. Absolute lifetime: 8 hours.
- State-changing requests require a synchronizer CSRF token and an exact configured Origin match. SameSite is defense in depth, not the sole CSRF control.
- Logout revokes the local session first. Refresh-token revocation is attempted best-effort; local logout remains authoritative if the provider is unavailable.

## 5. Token refresh

The session store exposes a server-side access-token retrieval helper. When a token approaches expiry, the session row is selected FOR UPDATE; the refresh request occurs while the row lock is held, and the rotated token bundle is encrypted before commit. Concurrent refresh attempts serialize on the same row. If refresh fails, the session is revoked and an expired access token is never returned. If the provider omits a replacement refresh token, the previous refresh token is retained.

No browser route exposes this token helper or returns the token bundle.

## 6. PostgreSQL persistence

Migrations:

- 006_web_sessions.cjs: global, tenant-independent web session records.
- 007_web_login_transactions.cjs: short-lived, one-time OIDC login transactions.

These are authentication infrastructure records, not tenant business data, so they are not tenant-scoped. The application role receives explicit table privileges through the CI setup; no elevated role or RLS bypass is introduced. Session and login-state identifiers are stored as hashes. Token/PKCE/nonce payloads are encrypted.

The session store provides revokeAllForUser for future account lifecycle integration. Wiring that hook into user disablement, unlink, credential reset, and compromise workflows remains a follow-up.

## 7. Runtime configuration

Required environment variables:

- DATABASE_URL
- OIDC_ISSUER
- OIDC_CLIENT_ID
- OIDC_CLIENT_SECRET
- OIDC_REDIRECT_URI (must be same-origin https://.../auth/callback)
- PUBLIC_ORIGIN (canonical HTTPS origin)
- SESSION_ENCRYPTION_KEY (base64 encoding of exactly 32 random bytes)

Optional:

- DATABASE_SSL (defaults to require)
- HOST (defaults to 0.0.0.0)
- PORT (defaults to 3000)

Build and start:

    npm run build
    npm run start:web

TLS termination and secret delivery are deployment responsibilities. No secret values are committed to the repository.

## 8. Verification evidence

CI run: https://github.com/hamidyaghobi70-beep/infinyx/actions/runs/45941140918

- 19 test files passed.
- 132 tests passed.
- TypeScript typecheck passed.
- Web BFF production build passed.
- Migration syntax checks and PostgreSQL migration application passed.
- npm audit: zero vulnerabilities.
- Tests use synthetic OIDC responses and fake provider behavior; no live Keycloak server was contacted.

## 9. Explicitly not performed

- No Keycloak realm/client creation or live provider configuration.
- No staging deployment, public exposure, or production secrets.
- No login UI, mobile client, tenant-selection UI, or business API proxy endpoints.
- No provider end-session redirect; logout currently performs local revocation plus best-effort refresh-token revocation.
- No dedicated web-auth audit-event table or operational key-rotation runbook.
- No merge, release, or deployment; main remains unchanged.


## 10. Durable OIDC refresh reservation

A refresh attempt is claimed by an atomic update to `web_sessions.refresh_attempt_id`
before any OIDC provider request. No database client or transaction is held while
waiting on the provider. Only the request holding that UUID can persist the rotated
token bundle. Competing requests and requests after process/connection loss fail
closed while the reservation remains set.

This is intentionally conservative: if the provider outcome is ambiguous (including
a process crash or database disconnect after the provider may have rotated a
single-use refresh token), the session is not automatically retried. The user must
authenticate again. This trades availability for protection against refresh-token
reuse and concurrent rotation. A successful compare-and-set clears the reservation;
a definite provider failure revokes the session.
