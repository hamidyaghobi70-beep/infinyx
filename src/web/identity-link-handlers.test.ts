import { afterEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import type * as oidc from "openid-client";
import { createBffHttpServer } from "./bff-server.js";
import { createCsrfToken, createOpaqueSessionId, hashCsrfToken } from "./session-crypto.js";
import { createIdentityLinkHandlers } from "./identity-link-handlers.js";
import type { OidcBffClient, OidcBffConfiguration } from "./oidc-bff.js";

const servers: Server[] = [];
const issuer = "https://identity.infinyx.test";
const publicOrigin = "https://app.infinyx.test";
const userId = "10000000-0000-4000-8000-000000000001";

async function openServer(handlers: ReturnType<typeof createIdentityLinkHandlers>): Promise<string> {
  const server = createBffHttpServer({
    startLogin: (_req, res) => { res.statusCode = 204; res.end(); },
    handleCallback: (_req, res) => { res.statusCode = 204; res.end(); },
    getSession: (_req, res) => { res.statusCode = 204; res.end(); },
    logout: (_req, res) => { res.statusCode = 204; res.end(); },
    ...handlers
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server =>
    new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  ));
});

function setup() {
  const sessionId = createOpaqueSessionId();
  const csrfToken = createCsrfToken();
  const session = {
    userId,
    issuer,
    subject: "existing-subject",
    csrfTokenHash: hashCsrfToken(csrfToken),
    csrfToken,
    tokenBundle: { accessToken: "unused", accessTokenExpiresAt: Date.now() + 300_000 },
    idleExpiresAt: new Date(Date.now() + 1_800_000),
    absoluteExpiresAt: new Date(Date.now() + 28_800_000)
  };
  const sessions = {
    findActive: vi.fn(async () => session)
  };
  const securityTransactions = {
    createTransaction: vi.fn(async (..._args: unknown[]) => undefined),
    createLinkTransactionFromStepUpGrant: vi.fn(async (..._args: unknown[]) => undefined)
  };
  const authorizationParams: Record<string, string>[] = [];
  const oidcClient = {
    randomState: () => createOpaqueSessionId(),
    randomNonce: () => createOpaqueSessionId(),
    randomPKCECodeVerifier: () => "A".repeat(64),
    calculatePKCECodeChallenge: async () => "synthetic-challenge",
    buildAuthorizationUrl: (_client: unknown, params: Record<string, string>) => {
      authorizationParams.push(params);
      return new URL("https://idp.example.test/authorize");
    }
  } as unknown as OidcBffClient;
  const configuration: OidcBffConfiguration = {
    issuer,
    clientId: "infinyx-web",
    clientSecret: "synthetic-secret",
    redirectUri: `${publicOrigin}/auth/callback`,
    publicOrigin
  };
  const handlers = createIdentityLinkHandlers({
    configuration,
    client: {} as oidc.Configuration,
    oidcClient,
    database: {} as never,
    sessions: sessions as never,
    securityTransactions: securityTransactions as never
  });
  return {
    handlers, sessionId, csrfToken, authorizationParams,
    securityTransactions
  };
}

describe("OIDC external identity link initiation", () => {
  it("requires CSRF and starts a fresh reauthentication bound to the current session", async () => {
    const f = setup();
    const base = await openServer(f.handlers);
    const denied = await fetch(`${base}/account/security/reauth`, {
      method: "POST",
      headers: { cookie: `__Host-infinyx_session=${f.sessionId}` }
    });
    expect(denied.status).toBe(403);
    expect(f.securityTransactions.createTransaction).not.toHaveBeenCalled();

    const response = await fetch(`${base}/account/security/reauth`, {
      method: "POST",
      headers: {
        cookie: `__Host-infinyx_session=${f.sessionId}`,
        origin: publicOrigin,
        "x-infinyx-csrf": f.csrfToken
      },
      redirect: "manual"
    });
    expect(response.status).toBe(302);
    expect(f.securityTransactions.createTransaction).toHaveBeenCalledOnce();
    expect(f.securityTransactions.createTransaction.mock.calls[0]?.[3]).toBe(f.sessionId);
    expect(f.securityTransactions.createTransaction.mock.calls[0]?.[4]).toBe("reauth_identity_link");
    expect(f.authorizationParams[0]).toMatchObject({
      redirect_uri: `${publicOrigin}/auth/reauth/callback`,
      prompt: "login",
      max_age: "0",
      code_challenge_method: "S256"
    });
  });

  it("starts unlink reauthentication with its own purpose and callback", async () => {
    const f = setup();
    const base = await openServer(f.handlers);
    const response = await fetch(`${base}/account/security/reauth-unlink`, {
      method: "POST",
      headers: {
        cookie: `__Host-infinyx_session=${f.sessionId}`,
        origin: publicOrigin,
        "x-infinyx-csrf": f.csrfToken
      },
      redirect: "manual"
    });
    expect(response.status).toBe(302);
    expect(f.securityTransactions.createTransaction).toHaveBeenCalledOnce();
    expect(f.securityTransactions.createTransaction.mock.calls[0]?.[4]).toBe("reauth_identity_unlink");
    expect(f.authorizationParams[0]).toMatchObject({
      redirect_uri: `${publicOrigin}/auth/reauth-unlink/callback`,
      prompt: "login", max_age: "0", code_challenge_method: "S256"
    });
  });

  it("consumes the step-up grant when starting the independently authenticated new identity flow", async () => {
    const f = setup();
    const base = await openServer(f.handlers);
    const grant = createOpaqueSessionId();
    const response = await fetch(`${base}/account/identities/link`, {
      method: "POST",
      headers: {
        cookie: `__Host-infinyx_session=${f.sessionId}; __Host-infinyx_stepup=${grant}`,
        origin: publicOrigin,
        "x-infinyx-csrf": f.csrfToken
      },
      redirect: "manual"
    });
    expect(response.status).toBe(302);
    expect(f.securityTransactions.createLinkTransactionFromStepUpGrant).toHaveBeenCalledOnce();
    expect(f.securityTransactions.createLinkTransactionFromStepUpGrant.mock.calls[0]?.[0]).toBe(grant);
    expect(f.authorizationParams[0]).toMatchObject({
      redirect_uri: `${publicOrigin}/auth/identity-link/callback`,
      prompt: "login",
      code_challenge_method: "S256"
    });
    expect(f.authorizationParams[0]?.max_age).toBeUndefined();
  });

  it("rejects link initiation without a step-up grant", async () => {
    const f = setup();
    const base = await openServer(f.handlers);
    const response = await fetch(`${base}/account/identities/link`, {
      method: "POST",
      headers: {
        cookie: `__Host-infinyx_session=${f.sessionId}`,
        origin: publicOrigin,
        "x-infinyx-csrf": f.csrfToken
      }
    });
    expect(response.status).toBe(401);
    expect(f.securityTransactions.createLinkTransactionFromStepUpGrant).not.toHaveBeenCalled();
  });
});
