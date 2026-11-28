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

The session store exposes a server-side access-token retrieval helper. When a token approaches expiry, the store first reads the current session bundle, then atomically claims the refresh attempt by setting `refresh_attempt_id` only if no other attempt has claimed the session and the stored bundle is unchanged. This update commits before the OIDC network request; no PostgreSQL client or transaction is held while waiting for the provider.

Only the attempt holding that UUID can persist the rotated bundle. Persistence uses a compare-and-set against both the attempt UUID and the original encrypted bundle, and clears the reservation only when the update succeeds. Concurrent attempts fail closed. If the refresh callback throws or returns invalid data, the current implementation revokes the session. If persistence fails after the provider may have rotated a single-use refresh token, the reservation is deliberately retained and the store returns an operation error; it must not retry the old refresh token. If the provider omits a replacement refresh token, the previous refresh token is retained. An expired access token is never returned.

No browser route exposes this token helper or returns the token bundle.

## 6. PostgreSQL persistence

Migrations:

- 006_web_sessions.cjs: global, tenant-independent web session records.
- 007_web_login_transactions.cjs: short-lived, one-time OIDC login transactions.
- 016_durable_session_refresh_reservation.cjs: adds the durable OIDC refresh-attempt reservation.

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
token bundle. Competing requests fail closed while the reservation remains set.

This is intentionally conservative. If the provider call throws, the current code
revokes the session. If the process or database connection fails after the provider
may have rotated a single-use refresh token, the reservation remains set and the
session is not automatically retried. The user may need to authenticate again.
This trades availability for protection against refresh-token reuse and concurrent
rotation.

## 11. Operational handling of a pending refresh reservation

### What the reservation means

A non-null `web_sessions.refresh_attempt_id` means one refresh attempt claimed the
session and has not completed its successful compare-and-set. It does **not** prove
that the provider is still processing the request: the application process may have
stopped, the database may have become unavailable, or persistence may have failed
after the provider rotated its token.

Migration 016 currently stores the attempt UUID but does not store a claim timestamp
or provider outcome. Therefore operators cannot safely infer the age or outcome of
a reservation from this column alone.

### Safe operator rules

- Do not clear `refresh_attempt_id` manually just to make refresh work again.
- Do not retry the previous refresh token or build an automatic job that clears
  reservations based only on their apparent age.
- Do not treat a non-null reservation as proof that a user account is disabled or
  that the session has expired. Session lookup and touch intentionally continue to
  work while a refresh reservation is pending.
- If a user is affected by a stuck or ambiguous refresh, use the normal logout /
  session-revocation path and have the user authenticate again. Do not attempt to
  recover the old refresh token.
- Preserve relevant application and provider logs for incident review, but never
  log raw access tokens, refresh tokens, ID tokens, session cookies, or CSRF tokens.

### Read-only monitoring

The following aggregate query counts sessions with a pending reservation without
exposing session identifiers or token material:

```sql
SELECT count(*) AS pending_refresh_reservations
  FROM web_sessions
 WHERE refresh_attempt_id IS NOT NULL
   AND revoked_at IS NULL;
```

This count is a signal for investigation, not a safe cleanup instruction. Because
the current schema has no reservation timestamp, it cannot distinguish a slow
in-flight refresh from an abandoned reservation. Do not create age-based alerts or
automatic cleanup from this query alone.

### Follow-up before production operations

Add a reservation timestamp and structured, secret-free observability before
building age-based alerts or automated recovery. Any future recovery design must
distinguish a provider-confirmed failure from an ambiguous outcome and must never
replay a potentially consumed refresh token. This runbook does not authorize
manual database edits, merging, or deployment.
