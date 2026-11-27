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
  createExpiredSessionCookie,
  createExpiredStepUpCookie,
  createIdentitySecurityCookie,
  readIdentitySecurityCookie
} from "./session-cookie.js";
import type { OidcBffClient, OidcBffConfiguration } from "./oidc-bff.js";
import { PostgresAccountRecoveryTransactionStore } from "./account-recovery-transactions.js";
import { recoverSuspendedAccount } from "./account-recovery-workflow.js";
import { completeAccountSessionRevocation } from "./account-session-revocation.js";
import type { PostgresWebSessionStore } from "./session-store.js";

interface Dependencies {
  readonly configuration: OidcBffConfiguration;
  readonly client: oidc.Configuration;
  readonly oidcClient?: OidcBffClient;
  readonly database: Pool;
  readonly sessions: PostgresWebSessionStore;
  readonly recoveryTransactions: PostgresAccountRecoveryTransactionStore;
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
  } catch {
    return null;
  }
}

function callbackParameters(url: URL, issuer: string): { state: string; code: string } | null {
  const states = url.searchParams.getAll("state");
  const codes = url.searchParams.getAll("code");
  const errors = url.searchParams.getAll("error");
  const issuers = url.searchParams.getAll("iss");
  if (states.length !== 1 || codes.length !== 1 || errors.length > 0 ||
      issuers.length > 1 || (issuers.length === 1 && issuers[0] !== issuer) ||
      !states[0] || !codes[0] || states[0].length > 512 || codes[0].length > 4096) {
    return null;
  }
  return { state: states[0], code: codes[0] };
}

function validFreshClaims(
  claims: unknown,
  issuer: string,
  now: Date
): claims is { iss: string; sub: string; auth_time: number } {
  if (!claims || typeof claims !== "object") return false;
  const value = claims as { iss?: unknown; sub?: unknown; auth_time?: unknown };
  const nowSeconds = Math.floor(now.getTime() / 1000);
  return value.iss === issuer &&
    typeof value.sub === "string" && value.sub.length > 0 &&
    value.sub.length <= 512 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value.sub) &&
    typeof value.auth_time === "number" && Number.isSafeInteger(value.auth_time) &&
    value.auth_time <= nowSeconds + 60 && value.auth_time >= nowSeconds - 300;
}

export function createAccountRecoveryHandlers(deps: Dependencies) {
  const now = deps.now ?? (() => new Date());
  const clientApi = deps.oidcClient ?? oidc;
  const callbackPath = "/auth/account-recovery/callback";

  return Object.freeze({
    startAccountRecovery: async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
      if (request.headers.origin !== deps.configuration.publicOrigin) {
        return sendJson(response, 403, { error: "account_recovery_unavailable" });
      }

      const state = clientApi.randomState();
      const nonce = clientApi.randomNonce();
      const codeVerifier = clientApi.randomPKCECodeVerifier();
      const browserBinding = createOpaqueSessionId();
      const codeChallenge = await clientApi.calculatePKCECodeChallenge(codeVerifier);
      const payload: IdentitySecurityTransactionPayload = { codeVerifier, nonce };
      const expiresAt = new Date(now().getTime() + 5 * 60 * 1000);
      await deps.recoveryTransactions.create(state, browserBinding, payload, expiresAt);

      const authorizationUrl = clientApi.buildAuthorizationUrl(deps.client, {
        redirect_uri: `${deps.configuration.publicOrigin}${callbackPath}`,
        response_type: "code",
        scope: "openid",
        prompt: "login",
        max_age: "0",
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        state,
        nonce
      });

      response.statusCode = 302;
      response.setHeader("Set-Cookie", createIdentitySecurityCookie(browserBinding));
      response.setHeader("Location", authorizationUrl.href);
      response.end();
    },

    handleAccountRecoveryCallback: async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
      const incoming = requestUrl(request, deps.configuration.publicOrigin);
      const binding = readIdentitySecurityCookie(request.headers.cookie);
      if (!incoming || incoming.pathname !== callbackPath || !binding) {
        return sendJson(response, 401, { error: "account_recovery_unavailable" }, [
          createExpiredIdentitySecurityCookie()
        ]);
      }

      const params = callbackParameters(incoming, deps.configuration.issuer);
      if (!params) {
        return sendJson(response, 401, { error: "account_recovery_unavailable" }, [
          createExpiredIdentitySecurityCookie()
        ]);
      }

      const pending = await deps.recoveryTransactions.consume(params.state, binding);
      if (!pending) {
        return sendJson(response, 401, { error: "account_recovery_unavailable" }, [
          createExpiredIdentitySecurityCookie()
        ]);
      }

      const callbackUrl = new URL(`${deps.configuration.publicOrigin}${callbackPath}`);
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
        return sendJson(response, 401, { error: "account_recovery_unavailable" }, [
          createExpiredIdentitySecurityCookie()
        ]);
      }

      const claims = tokenResponse.claims();
      const authenticatedAt = now();
      if (!validFreshClaims(claims, deps.configuration.issuer, authenticatedAt)) {
        return sendJson(response, 401, { error: "account_recovery_unavailable" }, [
          createExpiredIdentitySecurityCookie()
        ]);
      }

      const correlationId = randomUUID();
      const result = await recoverSuspendedAccount(
        deps.database, claims.iss, claims.sub, correlationId
      );
      if (result.outcome !== "recovered") {
        return sendJson(response, 401, { error: "account_recovery_unavailable" }, [
          createExpiredIdentitySecurityCookie()
        ]);
      }

      const revoked = await completeAccountSessionRevocation(
        deps.database, deps.sessions, result.userId, result.outboxId
      );
      if (!revoked) {
        return sendJson(response, 503, { error: "account_recovery_pending" }, [
          createExpiredSessionCookie(),
          createExpiredStepUpCookie(),
          createExpiredIdentitySecurityCookie()
        ]);
      }

      response.statusCode = 303;
      response.setHeader("Set-Cookie", [
        createExpiredSessionCookie(),
        createExpiredStepUpCookie(),
        createExpiredIdentitySecurityCookie()
      ]);
      response.setHeader("Location", "/auth/login");
      response.end();
    }
  });
}
