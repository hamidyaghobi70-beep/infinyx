import * as oidc from "openid-client";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createOpaqueSessionId,
  type IdentitySecurityTransactionPayload
} from "./session-crypto.js";
import {
  createExpiredIdentitySecurityCookie,
  createExpiredStepUpCookie,
  createIdentitySecurityCookie,
  createExpiredSessionCookie,
  readIdentitySecurityCookie,
  readSessionCookie
} from "./session-cookie.js";
import { validateBffCsrf } from "./csrf.js";
import type { OidcBffClient, OidcBffConfiguration } from "./oidc-bff.js";
import { PostgresIdentitySecurityTransactionStore } from "./identity-security-transactions.js";
import { PostgresWebSessionStore } from "./session-store.js";
import {
  completeIdentitySessionRevocation,
  registerVerifiedIdentityLink
} from "./identity-link-workflow.js";
import { unlinkVerifiedIdentity } from "./identity-unlink-workflow.js";

interface Dependencies {
  readonly configuration: OidcBffConfiguration;
  readonly client: oidc.Configuration;
  readonly oidcClient?: OidcBffClient;
  readonly database: Pool;
  readonly sessions: PostgresWebSessionStore;
  readonly securityTransactions: PostgresIdentitySecurityTransactionStore;
  readonly now?: () => Date;
}

function sendJson(response: ServerResponse, status: number, body: unknown, cookies: string[] = []): void {
  if (response.headersSent || response.writableEnded) return;
  if (cookies.length) response.setHeader("Set-Cookie", cookies);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function requestUrl(request: IncomingMessage, publicOrigin: string): URL | null {
  try {
    const parsed = new URL(request.url ?? "/", publicOrigin);
    return parsed.origin === publicOrigin ? parsed : null;
  } catch { return null; }
}

function callbackParameters(url: URL, issuer: string): { state: string; code: string } | null {
  const states = url.searchParams.getAll("state");
  const codes = url.searchParams.getAll("code");
  const errors = url.searchParams.getAll("error");
  const issuers = url.searchParams.getAll("iss");
  if (states.length !== 1 || codes.length !== 1 || errors.length ||
      issuers.length > 1 || (issuers.length === 1 && issuers[0] !== issuer) ||
      !states[0] || !codes[0] || states[0].length > 512 || codes[0].length > 4096) return null;
  return { state: states[0], code: codes[0] };
}

function validClaims(claims: unknown, issuer: string): claims is { iss: string; sub: string } {
  if (!claims || typeof claims !== "object") return false;
  const value = claims as { iss?: unknown; sub?: unknown };
  return value.iss === issuer &&
    typeof value.sub === "string" && value.sub.length > 0 &&
    value.sub.length <= 512 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value.sub);
}

export function createIdentityLinkHandlers(deps: Dependencies) {
  const now = deps.now ?? (() => new Date());
  const clientApi = deps.oidcClient ?? oidc;

  async function beginAuthorization(
    response: ServerResponse,
    purpose: "reauth_identity_link" | "reauth_identity_unlink" | "identity_link",
    userId: string,
    sessionId: string,
    grant?: string
  ): Promise<void> {
    const state = clientApi.randomState();
    const nonce = clientApi.randomNonce();
    const codeVerifier = clientApi.randomPKCECodeVerifier();
    const browserBinding = createOpaqueSessionId();
    const codeChallenge = await clientApi.calculatePKCECodeChallenge(codeVerifier);
    const payload: IdentitySecurityTransactionPayload = { codeVerifier, nonce };
    const expiresAt = new Date(now().getTime() + 5 * 60 * 1000);

    if (purpose === "reauth_identity_link" || purpose === "reauth_identity_unlink") {
      await deps.securityTransactions.createTransaction(
        state, browserBinding, userId, sessionId, purpose, payload, expiresAt
      );
    } else {
      if (!grant) throw new Error("Missing step-up grant.");
      await deps.securityTransactions.createLinkTransactionFromStepUpGrant(
        grant, state, browserBinding, userId, sessionId, payload, expiresAt
      );
    }

    const callbackPath = purpose === "reauth_identity_link"
      ? "/auth/reauth/callback"
      : purpose === "reauth_identity_unlink"
        ? "/auth/reauth-unlink/callback"
        : "/auth/identity-link/callback";
    const authorizationUrl = clientApi.buildAuthorizationUrl(deps.client, {
      redirect_uri: `${deps.configuration.publicOrigin}${callbackPath}`,
      response_type: "code",
      scope: "openid",
      prompt: "login",
      ...(purpose === "reauth_identity_link" || purpose === "reauth_identity_unlink" ? { max_age: "0" } : {}),
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
      nonce
    });
    response.statusCode = 302;
    response.setHeader("Set-Cookie", [
      createIdentitySecurityCookie(browserBinding),
      createExpiredStepUpCookie()
    ]);
    response.setHeader("Location", authorizationUrl.href);
    response.end();
  }

  return Object.freeze({
    startReauth: async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
      const sessionId = readSessionCookie(request.headers.cookie);
      if (!sessionId) return sendJson(response, 401, { error: "authentication_required" });
      const session = await deps.sessions.findActive(sessionId);
      if (!session) return sendJson(response, 401, { error: "authentication_required" });
      if (!validateBffCsrf(request, session, deps.configuration.publicOrigin).ok) {
        return sendJson(response, 403, { error: "csrf_rejected" });
      }
      await beginAuthorization(response, "reauth_identity_link", session.userId, sessionId);
    },

    handleReauthCallback: async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
      const incoming = requestUrl(request, deps.configuration.publicOrigin);
      const binding = readIdentitySecurityCookie(request.headers.cookie);
      const sessionId = readSessionCookie(request.headers.cookie);
      if (!incoming || incoming.pathname !== "/auth/reauth/callback" || !binding || !sessionId) {
        return sendJson(response, 401, { error: "reauthentication_failed" }, [createExpiredIdentitySecurityCookie()]);
      }
      const session = await deps.sessions.findActive(sessionId);
      const params = callbackParameters(incoming, deps.configuration.issuer);
      if (!session || !params) {
        return sendJson(response, 401, { error: "reauthentication_failed" }, [createExpiredIdentitySecurityCookie()]);
      }
      const pending = await deps.securityTransactions.consumeTransaction(
        params.state, binding, session.userId, sessionId, "reauth_identity_link"
      );
      if (!pending) {
        return sendJson(response, 401, { error: "reauthentication_failed" }, [createExpiredIdentitySecurityCookie()]);
      }
      const callbackUrl = new URL(`${deps.configuration.publicOrigin}/auth/reauth/callback`);
      callbackUrl.search = incoming.search;
      let tokenResponse: Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>;
      try {
        tokenResponse = await clientApi.authorizationCodeGrant(deps.client, callbackUrl, {
          expectedState: params.state,
          expectedNonce: pending.payload.nonce,
          pkceCodeVerifier: pending.payload.codeVerifier,
          idTokenExpected: true
        });
      } catch {
        return sendJson(response, 401, { error: "reauthentication_failed" }, [createExpiredIdentitySecurityCookie()]);
      }
      const claims = tokenResponse.claims();
      if (!validClaims(claims, deps.configuration.issuer)) {
        return sendJson(response, 401, { error: "reauthentication_failed" }, [createExpiredIdentitySecurityCookie()]);
      }
      const current = await deps.sessions.findActive(sessionId);
      if (!current || current.userId !== session.userId) {
        return sendJson(response, 401, { error: "reauthentication_failed" }, [createExpiredIdentitySecurityCookie()]);
      }
      const owned = await deps.database.query(
        `SELECT 1
           FROM user_external_identities AS identity
           INNER JOIN user_external_identity_lifecycle AS lifecycle
             ON lifecycle.identity_id = identity.identity_id AND lifecycle.status = 'active'
          WHERE identity.user_id = $1::uuid AND identity.issuer = $2 AND identity.subject = $3
          LIMIT 1`,
        [session.userId, claims.iss, claims.sub]
      );
      if (owned.rowCount !== 1) {
        return sendJson(response, 401, { error: "reauthentication_failed" }, [createExpiredIdentitySecurityCookie()]);
      }
      const grant = await deps.securityTransactions.issueVerifiedStepUpGrant(
        pending.transactionId, session.userId, sessionId, "identity_link",
        new Date(now().getTime() + 5 * 60 * 1000)
      );
      if (!grant) return sendJson(response, 401, { error: "reauthentication_failed" }, [createExpiredIdentitySecurityCookie()]);
      response.statusCode = 303;
      response.setHeader("Set-Cookie", [
        createIdentitySecurityCookie(grant, "stepup"),
        createExpiredIdentitySecurityCookie()
      ]);
      response.setHeader("Location", "/account/security");
      response.end();
    },

    startUnlinkReauth: async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
      const sessionId = readSessionCookie(request.headers.cookie);
      if (!sessionId) return sendJson(response, 401, { error: "authentication_required" });
      const session = await deps.sessions.findActive(sessionId);
      if (!session) return sendJson(response, 401, { error: "authentication_required" });
      if (!validateBffCsrf(request, session, deps.configuration.publicOrigin).ok) {
        return sendJson(response, 403, { error: "csrf_rejected" });
      }
      await beginAuthorization(response, "reauth_identity_unlink", session.userId, sessionId);
    },

    handleUnlinkReauthCallback: async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
      const incoming = requestUrl(request, deps.configuration.publicOrigin);
      const binding = readIdentitySecurityCookie(request.headers.cookie);
      const sessionId = readSessionCookie(request.headers.cookie);
      if (!incoming || incoming.pathname !== "/auth/reauth-unlink/callback" || !binding || !sessionId) {
        return sendJson(response, 401, { error: "reauthentication_failed" }, [createExpiredIdentitySecurityCookie()]);
      }
      const session = await deps.sessions.findActive(sessionId);
      const params = callbackParameters(incoming, deps.configuration.issuer);
      if (!session || !params) {
        return sendJson(response, 401, { error: "reauthentication_failed" }, [createExpiredIdentitySecurityCookie()]);
      }
      const pending = await deps.securityTransactions.consumeTransaction(
        params.state, binding, session.userId, sessionId, "reauth_identity_unlink"
      );
      if (!pending) {
        return sendJson(response, 401, { error: "reauthentication_failed" }, [createExpiredIdentitySecurityCookie()]);
      }
      const callbackUrl = new URL(`${deps.configuration.publicOrigin}/auth/reauth-unlink/callback`);
      callbackUrl.search = incoming.search;
      let tokenResponse: Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>;
      try {
        tokenResponse = await clientApi.authorizationCodeGrant(deps.client, callbackUrl, {
          expectedState: params.state,
          expectedNonce: pending.payload.nonce,
          pkceCodeVerifier: pending.payload.codeVerifier,
          idTokenExpected: true
        });
      } catch {
        return sendJson(response, 401, { error: "reauthentication_failed" }, [createExpiredIdentitySecurityCookie()]);
      }
      const claims = tokenResponse.claims();
      if (!validClaims(claims, deps.configuration.issuer)) {
        return sendJson(response, 401, { error: "reauthentication_failed" }, [createExpiredIdentitySecurityCookie()]);
      }
      const current = await deps.sessions.findActive(sessionId);
      if (!current || current.userId !== session.userId) {
        return sendJson(response, 401, { error: "reauthentication_failed" }, [createExpiredIdentitySecurityCookie()]);
      }
      const owned = await deps.database.query(
        `SELECT 1
           FROM user_external_identities AS identity
           INNER JOIN user_external_identity_lifecycle AS lifecycle
             ON lifecycle.identity_id = identity.identity_id AND lifecycle.status = 'active'
          WHERE identity.user_id = $1::uuid AND identity.issuer = $2 AND identity.subject = $3
          LIMIT 1`,
        [session.userId, claims.iss, claims.sub]
      );
      if (owned.rowCount !== 1) {
        return sendJson(response, 401, { error: "reauthentication_failed" }, [createExpiredIdentitySecurityCookie()]);
      }
      const grant = await deps.securityTransactions.issueVerifiedStepUpGrant(
        pending.transactionId, session.userId, sessionId, "identity_unlink",
        new Date(now().getTime() + 5 * 60 * 1000)
      );
      if (!grant) return sendJson(response, 401, { error: "reauthentication_failed" }, [createExpiredIdentitySecurityCookie()]);
      response.statusCode = 303;
      response.setHeader("Set-Cookie", [
        createIdentitySecurityCookie(grant, "stepup"),
        createExpiredIdentitySecurityCookie()
      ]);
      response.setHeader("Location", "/account/security");
      response.end();
    },

    unlinkIdentity: async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
      const incoming = requestUrl(request, deps.configuration.publicOrigin);
      const match = incoming?.pathname.match(/^\\/account\\/identities\\/([0-9a-f-]{36})\\/unlink$/iu);
      const sessionId = readSessionCookie(request.headers.cookie);
      const grant = readIdentitySecurityCookie(request.headers.cookie, "stepup");
      if (!sessionId || !grant || !match) {
        return sendJson(response, 401, { error: "identity_unlink_failed" }, [createExpiredStepUpCookie()]);
      }
      const session = await deps.sessions.findActive(sessionId);
      if (!session) return sendJson(response, 401, { error: "authentication_required" }, [createExpiredSessionCookie()]);
      if (!validateBffCsrf(request, session, deps.configuration.publicOrigin).ok) {
        return sendJson(response, 403, { error: "csrf_rejected" });
      }
      const result = await unlinkVerifiedIdentity(
        deps.database, session.userId, sessionId, grant, match[1]!, randomUUID()
      );
      if (result.outcome === "step_up_required") {
        return sendJson(response, 401, { error: "step_up_required" }, [createExpiredStepUpCookie()]);
      }
      if (result.outcome === "denied") {
        return sendJson(response, 409, { error: "identity_unlink_failed" }, [createExpiredStepUpCookie()]);
      }
      const revoked = await completeIdentitySessionRevocation(
        deps.database, deps.sessions, session.userId, result.outboxId
      );
      if (!revoked) {
        return sendJson(response, 503, { error: "identity_change_pending" }, [
          createExpiredSessionCookie(), createExpiredStepUpCookie(), createExpiredIdentitySecurityCookie()
        ]);
      }
      response.statusCode = 303;
      response.setHeader("Set-Cookie", [
        createExpiredSessionCookie(), createExpiredStepUpCookie(), createExpiredIdentitySecurityCookie()
      ]);
      response.setHeader("Location", "/account/security");
      response.end();
    },

    startLink: async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
      const sessionId = readSessionCookie(request.headers.cookie);
      const grant = readIdentitySecurityCookie(request.headers.cookie, "stepup");
      if (!sessionId || !grant) return sendJson(response, 401, { error: "step_up_required" });
      const session = await deps.sessions.findActive(sessionId);
      if (!session) return sendJson(response, 401, { error: "authentication_required" });
      if (!validateBffCsrf(request, session, deps.configuration.publicOrigin).ok) {
        return sendJson(response, 403, { error: "csrf_rejected" });
      }
      await beginAuthorization(response, "identity_link", session.userId, sessionId, grant);
    },

    handleLinkCallback: async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
      const incoming = requestUrl(request, deps.configuration.publicOrigin);
      const binding = readIdentitySecurityCookie(request.headers.cookie);
      const sessionId = readSessionCookie(request.headers.cookie);
      if (!incoming || incoming.pathname !== "/auth/identity-link/callback" || !binding || !sessionId) {
        return sendJson(response, 401, { error: "identity_link_failed" }, [createExpiredIdentitySecurityCookie()]);
      }
      const session = await deps.sessions.findActive(sessionId);
      const params = callbackParameters(incoming, deps.configuration.issuer);
      if (!session || !params) {
        return sendJson(response, 401, { error: "identity_link_failed" }, [createExpiredIdentitySecurityCookie()]);
      }
      const pending = await deps.securityTransactions.consumeTransaction(
        params.state, binding, session.userId, sessionId, "identity_link"
      );
      if (!pending) {
        return sendJson(response, 401, { error: "identity_link_failed" }, [createExpiredIdentitySecurityCookie()]);
      }
      const callbackUrl = new URL(`${deps.configuration.publicOrigin}/auth/identity-link/callback`);
      callbackUrl.search = incoming.search;
      let tokenResponse: Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>;
      try {
        tokenResponse = await clientApi.authorizationCodeGrant(deps.client, callbackUrl, {
          expectedState: params.state,
          expectedNonce: pending.payload.nonce,
          pkceCodeVerifier: pending.payload.codeVerifier,
          idTokenExpected: true
        });
      } catch {
        return sendJson(response, 401, { error: "identity_link_failed" }, [createExpiredIdentitySecurityCookie()]);
      }
      const claims = tokenResponse.claims();
      const current = await deps.sessions.findActive(sessionId);
      if (!validClaims(claims, deps.configuration.issuer) || !current || current.userId !== session.userId) {
        return sendJson(response, 401, { error: "identity_link_failed" }, [createExpiredIdentitySecurityCookie()]);
      }

      const correlationId = randomUUID();
      const result = await registerVerifiedIdentityLink(
        deps.database, session.userId, claims.iss, claims.sub, correlationId
      );
      if (result.outcome === "denied") {
        return sendJson(response, 409, { error: "identity_link_failed" }, [createExpiredIdentitySecurityCookie()]);
      }
      if (result.outcome === "already_linked") {
        response.statusCode = 303;
        response.setHeader("Set-Cookie", createExpiredIdentitySecurityCookie());
        response.setHeader("Location", "/account/security");
        response.end();
        return;
      }

      const revoked = await completeIdentitySessionRevocation(
        deps.database, deps.sessions, session.userId, result.outboxId
      );
      if (!revoked) {
        return sendJson(response, 503, { error: "identity_change_pending" }, [
          createExpiredSessionCookie(), createExpiredIdentitySecurityCookie()
        ]);
      }
      response.statusCode = 303;
      response.setHeader("Set-Cookie", [createExpiredSessionCookie(), createExpiredIdentitySecurityCookie()]);
      response.setHeader("Location", "/account/security");
      response.end();
    }
  });
}
