import * as oidc from "openid-client";
import type { Pool } from "pg";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createCsrfToken,
  createOpaqueSessionId
} from "./session-crypto.js";
import {
  createExpiredLoginTransactionCookie,
  createExpiredSessionCookie,
  createLoginTransactionCookie,
  createSessionCookie,
  readLoginTransactionCookie,
  readSessionCookie
} from "./session-cookie.js";
import { validateBffCsrf } from "./csrf.js";
import { PostgresOidcLoginTransactionStore } from "./oidc-login-transactions.js";
import { PostgresWebSessionStore } from "./session-store.js";

export interface OidcBffConfiguration {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly publicOrigin: string;
}

export class OidcBffConfigurationError extends Error {
  constructor() {
    super("OIDC BFF configuration is invalid.");
    this.name = "OidcBffConfigurationError";
  }
}

export function validateOidcBffConfiguration(value: OidcBffConfiguration): void {
  if (!value || typeof value.clientId !== "string" ||
      value.clientId.trim().length < 1 || value.clientId.length > 256 ||
      typeof value.clientSecret !== "string" ||
      value.clientSecret.trim().length < 1 || value.clientSecret.length > 4096) {
    throw new OidcBffConfigurationError();
  }

  let issuer: URL;
  let publicOrigin: URL;
  let redirectUri: URL;
  try {
    issuer = new URL(value.issuer);
    publicOrigin = new URL(value.publicOrigin);
    redirectUri = new URL(value.redirectUri);
  } catch {
    throw new OidcBffConfigurationError();
  }

  if (issuer.protocol !== "https:" || issuer.username || issuer.password ||
      issuer.search || issuer.hash ||
      publicOrigin.protocol !== "https:" || publicOrigin.origin !== value.publicOrigin ||
      publicOrigin.pathname !== "/" || publicOrigin.search || publicOrigin.hash ||
      redirectUri.protocol !== "https:" || redirectUri.origin !== publicOrigin.origin ||
      redirectUri.pathname !== "/auth/callback" || redirectUri.search || redirectUri.hash ||
      redirectUri.username || redirectUri.password) {
    throw new OidcBffConfigurationError();
  }
}

const MAX_PROVIDER_RESPONSE_BYTES = 256 * 1024;
const PROVIDER_TIMEOUT_MS = 5000;

async function providerFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS)
  });
  if (!response.body) return response;

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Provider response exceeded limit.");
      }
      chunks.push(Buffer.from(part.value));
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* ignore stream cleanup errors */ }
    throw error;
  }

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(Buffer.concat(chunks), {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function requireHttpsEndpoint(value: string | undefined): void {
  if (typeof value !== "string") throw new OidcBffConfigurationError();
  let endpoint: URL;
  try { endpoint = new URL(value); }
  catch { throw new OidcBffConfigurationError(); }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password ||
      endpoint.search || endpoint.hash) throw new OidcBffConfigurationError();
}

export async function discoverOidcClient(
  configuration: OidcBffConfiguration
): Promise<oidc.Configuration> {
  validateOidcBffConfiguration(configuration);
  try {
    const client = await oidc.discovery(
      new URL(configuration.issuer),
      configuration.clientId,
      configuration.clientSecret,
      undefined,
      {
        timeout: PROVIDER_TIMEOUT_MS / 1000,
        [oidc.customFetch]: providerFetch
      }
    );
    const metadata = client.serverMetadata();
    if (metadata.issuer !== configuration.issuer) throw new OidcBffConfigurationError();
    requireHttpsEndpoint(metadata.authorization_endpoint);
    requireHttpsEndpoint(metadata.token_endpoint);
    requireHttpsEndpoint(metadata.jwks_uri);
    if (metadata.revocation_endpoint !== undefined) requireHttpsEndpoint(metadata.revocation_endpoint);
    if (metadata.end_session_endpoint !== undefined) requireHttpsEndpoint(metadata.end_session_endpoint);
    return client;
  } catch {
    throw new OidcBffConfigurationError();
  }
}

export type OidcBffClient = Pick<typeof oidc,
  | "randomState"
  | "randomNonce"
  | "randomPKCECodeVerifier"
  | "calculatePKCECodeChallenge"
  | "buildAuthorizationUrl"
  | "authorizationCodeGrant"
  | "tokenRevocation"
  | "refreshTokenGrant"
>;

export interface OidcBffHandlerDependencies {
  readonly configuration: OidcBffConfiguration;
  readonly client: oidc.Configuration;
  readonly database: Pool;
  readonly sessions: PostgresWebSessionStore;
  readonly loginTransactions: PostgresOidcLoginTransactionStore;
  readonly oidcClient?: OidcBffClient;
  readonly now?: () => Date;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent || response.writableEnded) return;
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function sendLoginFailure(response: ServerResponse, status: number, error: string): void {
  response.setHeader("Set-Cookie", createExpiredLoginTransactionCookie());
  sendJson(response, status, { error });
}

function sendNoContent(response: ServerResponse, cookies?: string[]): void {
  if (cookies) response.setHeader("Set-Cookie", cookies);
  response.statusCode = 204;
  response.end();
}

function requestUrl(request: IncomingMessage, publicOrigin: string): URL | null {
  try {
    const parsed = new URL(request.url ?? "/", publicOrigin);
    return parsed.origin === publicOrigin ? parsed : null;
  } catch {
    return null;
  }
}

export function createOidcBffHandlers(dependencies: OidcBffHandlerDependencies) {
  validateOidcBffConfiguration(dependencies.configuration);
  const now = dependencies.now ?? (() => new Date());
  const clientApi = dependencies.oidcClient ?? oidc;

  return Object.freeze({
    startLogin: async (_request: IncomingMessage, response: ServerResponse): Promise<void> => {
      const state = clientApi.randomState();
      const nonce = clientApi.randomNonce();
      const codeVerifier = clientApi.randomPKCECodeVerifier();
      const browserBinding = createOpaqueSessionId();
      const codeChallenge = await clientApi.calculatePKCECodeChallenge(codeVerifier);
      const expiresAt = new Date(now().getTime() + 5 * 60 * 1000);

      await dependencies.loginTransactions.create(
        state,
        browserBinding,
        { codeVerifier, nonce },
        expiresAt
      );

      const authorizationUrl = clientApi.buildAuthorizationUrl(dependencies.client, {
        redirect_uri: dependencies.configuration.redirectUri,
        response_type: "code",
        scope: "openid",
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        state,
        nonce
      });

      response.statusCode = 302;
      response.setHeader("Set-Cookie", createLoginTransactionCookie(browserBinding));
      response.setHeader("Location", authorizationUrl.href);
      response.end();
    },

    handleCallback: async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
      const incoming = requestUrl(request, dependencies.configuration.publicOrigin);
      const binding = readLoginTransactionCookie(request.headers.cookie);
      if (!incoming || incoming.pathname !== "/auth/callback" || !binding) {
        sendLoginFailure(response, 401, "authentication_failed");
        return;
      }

      const states = incoming.searchParams.getAll("state");
      const codes = incoming.searchParams.getAll("code");
      const errors = incoming.searchParams.getAll("error");
      const issuers = incoming.searchParams.getAll("iss");
      if (errors.length > 0 || states.length !== 1 || codes.length !== 1 ||
          issuers.length > 1 || (issuers.length === 1 && issuers[0] !== dependencies.configuration.issuer)) {
        sendLoginFailure(response, 401, "authentication_failed");
        return;
      }

      const state = states[0];
      if (!state || !codes[0]) {
        sendLoginFailure(response, 401, "authentication_failed");
        return;
      }

      const pending = await dependencies.loginTransactions.consume(state, binding);
      if (!pending) {
        sendLoginFailure(response, 401, "authentication_failed");
        return;
      }

      const callbackUrl = new URL(dependencies.configuration.redirectUri);
      callbackUrl.search = incoming.search;
      let tokenResponse: Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>;
      try {
        tokenResponse = await clientApi.authorizationCodeGrant(
          dependencies.client,
          callbackUrl,
          {
            expectedState: state,
            expectedNonce: pending.nonce,
            pkceCodeVerifier: pending.codeVerifier,
            idTokenExpected: true
          }
        );
      } catch {
        sendLoginFailure(response, 401, "authentication_failed");
        return;
      }

      const claims = tokenResponse.claims();
      const expiresIn = tokenResponse.expires_in;
      if (!claims || claims.iss !== dependencies.configuration.issuer ||
          typeof claims.sub !== "string" || claims.sub.length < 1 ||
          claims.sub.length > 512 || /[\u0000-\u001f\u007f-\u009f]/u.test(claims.sub) ||
          tokenResponse.token_type !== "bearer" ||
          typeof tokenResponse.access_token !== "string" ||
          tokenResponse.access_token.length < 1 || tokenResponse.access_token.length > 16_384 ||
          typeof expiresIn !== "number" || !Number.isSafeInteger(expiresIn) ||
          expiresIn < 1 || expiresIn > 86_400 ||
          (tokenResponse.refresh_token !== undefined &&
            (typeof tokenResponse.refresh_token !== "string" ||
             tokenResponse.refresh_token.length < 1 || tokenResponse.refresh_token.length > 16_384))) {
        sendLoginFailure(response, 401, "authentication_failed");
        return;
      }

      let userId: string | undefined;
      try {
        const identity = await dependencies.database.query<{ user_id: string }>(
          `SELECT identity.user_id::text AS user_id
             FROM user_external_identities AS identity
             INNER JOIN user_external_identity_lifecycle AS lifecycle
               ON lifecycle.identity_id = identity.identity_id
              AND lifecycle.status = 'active'
             INNER JOIN user_account_security AS account_security
               ON account_security.user_id = identity.user_id
              AND account_security.status = 'active'
            WHERE identity.issuer = $1 AND identity.subject = $2
              AND NOT EXISTS (
                SELECT 1 FROM user_account_session_revocation_outbox AS account_pending
                 WHERE account_pending.user_id = identity.user_id
                   AND account_pending.completed_at IS NULL
              )
              AND NOT EXISTS (
                SELECT 1 FROM identity_session_revocation_outbox AS pending
                 WHERE pending.user_id = identity.user_id AND pending.completed_at IS NULL
              )
            LIMIT 1`,
          [claims.iss, claims.sub]
        );
        userId = identity.rows[0]?.user_id;
      } catch {
        sendLoginFailure(response, 500, "internal_error");
        return;
      }
      if (!userId) {
        sendLoginFailure(response, 401, "authentication_failed");
        return;
      }

      const sessionId = createOpaqueSessionId();
      const csrfToken = createCsrfToken();
      const createdAt = now();
      const absoluteExpiresAt = new Date(createdAt.getTime() + 8 * 60 * 60 * 1000);
      const idleExpiresAt = new Date(createdAt.getTime() + 30 * 60 * 1000);
      try {
        await dependencies.sessions.create({
          sessionId,
          csrfToken,
          userId,
          issuer: claims.iss,
          subject: claims.sub,
          tokenBundle: {
            accessToken: tokenResponse.access_token,
            ...(tokenResponse.refresh_token === undefined ? {} : { refreshToken: tokenResponse.refresh_token }),
            accessTokenExpiresAt: createdAt.getTime() + expiresIn * 1000
          },
          idleExpiresAt,
          absoluteExpiresAt
        });
        const previousSession = readSessionCookie(request.headers.cookie);
        if (previousSession) await dependencies.sessions.revoke(previousSession);
      } catch {
        try { await dependencies.sessions.revoke(sessionId); } catch { /* best-effort orphan cleanup */ }
        sendLoginFailure(response, 500, "internal_error");
        return;
      }

      response.statusCode = 303;
      response.setHeader("Set-Cookie", [
        createSessionCookie(sessionId, { secure: true, maxAgeSeconds: 8 * 60 * 60 }),
        createExpiredLoginTransactionCookie()
      ]);
      response.setHeader("Location", "/");
      response.end();
    },

    getSession: async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
      const sessionId = readSessionCookie(request.headers.cookie);
      if (!sessionId) {
        sendJson(response, 200, { authenticated: false });
        return;
      }
      const session = await dependencies.sessions.findActive(sessionId);
      if (!session) {
        response.setHeader("Set-Cookie", createExpiredSessionCookie());
        sendJson(response, 200, { authenticated: false });
        return;
      }
      const idleExpiresAt = new Date(now().getTime() + 30 * 60 * 1000);
      if (!await dependencies.sessions.touch(sessionId, idleExpiresAt)) {
        response.setHeader("Set-Cookie", createExpiredSessionCookie());
        sendJson(response, 200, { authenticated: false });
        return;
      }
      sendJson(response, 200, {
        authenticated: true,
        userId: session.userId,
        csrfToken: session.csrfToken
      });
    },

    logout: async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
      const sessionId = readSessionCookie(request.headers.cookie);
      if (!sessionId) {
        sendNoContent(response, [createExpiredSessionCookie(), createExpiredLoginTransactionCookie()]);
        return;
      }
      const session = await dependencies.sessions.findActive(sessionId);
      if (!session) {
        sendNoContent(response, [createExpiredSessionCookie(), createExpiredLoginTransactionCookie()]);
        return;
      }
      const csrf = validateBffCsrf(request, session, dependencies.configuration.publicOrigin);
      if (!csrf.ok) {
        sendJson(response, 403, { error: "csrf_rejected" });
        return;
      }

      await dependencies.sessions.revoke(sessionId);
      if (session.tokenBundle.refreshToken) {
        try {
          await clientApi.tokenRevocation(dependencies.client, session.tokenBundle.refreshToken);
        } catch {
          // Local session revocation is authoritative; upstream revocation is best effort.
        }
      }
      sendNoContent(response, [createExpiredSessionCookie(), createExpiredLoginTransactionCookie()]);
    }
  });
}

/**
 * Returns a still-valid access token for a server-side session. Refresh is
 * serialized across application instances by a PostgreSQL session advisory
 * lock; refresh failures revoke the local session and never return an expired token.
 */
export async function getSessionAccessToken(
  sessionId: string,
  dependencies: OidcBffHandlerDependencies
): Promise<string | null> {
  const clientApi = dependencies.oidcClient ?? oidc;
  const now = dependencies.now ?? (() => new Date());
  return dependencies.sessions.getUsableAccessToken(sessionId, async (refreshToken) => {
    const response = await clientApi.refreshTokenGrant(dependencies.client, refreshToken);
    const expiresIn = response.expires_in;
    if (response.token_type !== "bearer" ||
        typeof response.access_token !== "string" ||
        response.access_token.length < 1 || response.access_token.length > 16_384 ||
        typeof expiresIn !== "number" || !Number.isSafeInteger(expiresIn) ||
        expiresIn < 1 || expiresIn > 86_400 ||
        (response.refresh_token !== undefined &&
          (typeof response.refresh_token !== "string" ||
           response.refresh_token.length < 1 || response.refresh_token.length > 16_384))) {
      throw new Error("Token refresh response is invalid.");
    }
    return {
      accessToken: response.access_token,
      ...(response.refresh_token === undefined ? {} : { refreshToken: response.refresh_token }),
      accessTokenExpiresAt: now().getTime() + expiresIn * 1000
    };
  });
}
