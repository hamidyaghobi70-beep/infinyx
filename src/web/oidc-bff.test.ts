import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { Server } from "node:http";
import type * as oidc from "openid-client";
import { createBffHttpServer } from "./bff-server.js";
import {
  createOpaqueSessionId,
  createCsrfToken,
  hashCsrfToken
} from "./session-crypto.js";
import {
  PostgresOidcLoginTransactionStore
} from "./oidc-login-transactions.js";
import {
  PostgresWebSessionStore
} from "./session-store.js";
import {
  createOidcBffHandlers,
  type OidcBffClient,
  type OidcBffConfiguration
} from "./oidc-bff.js";

const servers: Server[] = [];
const issuer = "https://identity.infinyx.test";
const publicOrigin = "https://app.infinyx.test";
const redirectUri = `${publicOrigin}/auth/callback`;
const userId = "10000000-0000-4000-8000-000000000001";

async function openServer(handlers: ReturnType<typeof createOidcBffHandlers>) {
  const server = createBffHttpServer({
    ...handlers,
    startReauth: (_request, response) => { response.statusCode = 404; response.end(); },
    handleReauthCallback: (_request, response) => { response.statusCode = 404; response.end(); },
    startUnlinkReauth: (_request, response) => { response.statusCode = 404; response.end(); },
    handleUnlinkReauthCallback: (_request, response) => { response.statusCode = 404; response.end(); },
    unlinkIdentity: (_request, response) => { response.statusCode = 404; response.end(); },
    startLink: (_request, response) => { response.statusCode = 404; response.end(); },
    handleLinkCallback: (_request, response) => { response.statusCode = 404; response.end(); },
    startAccountRecovery: (_request, response) => { response.statusCode = 404; response.end(); },
    handleAccountRecoveryCallback: (_request, response) => { response.statusCode = 404; response.end(); }
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  return `http://127.0.0.1:${address.port}`;
}

function getCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  return headers.getSetCookie?.() ?? [response.headers.get("set-cookie") ?? ""];
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server =>
    new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  ));
});

function setup() {
  const state = createOpaqueSessionId();
  const nonce = createOpaqueSessionId();
  const verifier = createOpaqueSessionId();
  const csrfToken = createCsrfToken();
  const tokenResponse = {
    access_token: "synthetic-access-token",
    refresh_token: "synthetic-refresh-token",
    token_type: "bearer",
    expires_in: 300,
    claims: () => ({ iss: issuer, sub: "subject-123", aud: "infinyx-web" })
  };
  const refreshTokenGrant = vi.fn(async () => ({
    access_token: "refreshed-access-token",
    refresh_token: "rotated-refresh-token",
    token_type: "bearer",
    expires_in: 300
  }));
  const authorizationCodeGrant = vi.fn(async (_config: unknown, _url: URL, checks: unknown) => {
    expect(checks).toEqual({
      expectedState: state,
      expectedNonce: nonce,
      pkceCodeVerifier: verifier,
      idTokenExpected: true
    });
    return tokenResponse;
  });
  const oidcClient = {
    randomState: () => state,
    randomNonce: () => nonce,
    randomPKCECodeVerifier: () => verifier,
    calculatePKCECodeChallenge: async (value: string) => {
      expect(value).toBe(verifier);
      return "synthetic-pkce-challenge";
    },
    buildAuthorizationUrl: (_config: unknown, params: Record<string, string>) => {
      expect(params.code_challenge_method).toBe("S256");
      expect(params.nonce).toBe(nonce);
      expect(params.state).toBe(state);
      return new URL("https://idp.example.test/authorize?client_id=infinyx-web");
    },
    authorizationCodeGrant,
    refreshTokenGrant,
    tokenRevocation: vi.fn(async () => undefined)
  } as unknown as OidcBffClient;

  let transactionConsumed = false;
  const pendingTransactions = {
    create: vi.fn(async () => undefined),
    consume: vi.fn(async () => {
      if (transactionConsumed) return null;
      transactionConsumed = true;
      return { codeVerifier: verifier, nonce };
    })
  } as unknown as PostgresOidcLoginTransactionStore;

  let createdSession: Record<string, unknown> | undefined;
  const storedSession = {
    userId,
    issuer,
    subject: "subject-123",
    csrfTokenHash: hashCsrfToken(csrfToken),
    csrfToken,
    tokenBundle: {
      accessToken: "synthetic-access-token",
      refreshToken: "synthetic-refresh-token",
      accessTokenExpiresAt: Date.now() + 300_000,
      csrfToken
    },
    idleExpiresAt: new Date(Date.now() + 1_800_000),
    absoluteExpiresAt: new Date(Date.now() + 28_800_000)
  };
  const sessions = {
    create: vi.fn(async (value: Record<string, unknown>) => { createdSession = value; }),
    findActive: vi.fn(async () => storedSession),
    touch: vi.fn(async () => true),
    revoke: vi.fn(async () => undefined),
    getUsableAccessToken: vi.fn(async (_sessionId: string, refresh: (token: string) => Promise<{ accessToken: string }>) => {
      const result = await refresh("synthetic-refresh-token");
      return result.accessToken;
    })
  } as unknown as PostgresWebSessionStore;

  const database = {
    query: vi.fn(async () => ({ rows: [{ user_id: userId }], rowCount: 1 }))
  } as unknown as Pool;

  const configuration: OidcBffConfiguration = {
    issuer,
    clientId: "infinyx-web",
    clientSecret: "synthetic-client-secret",
    redirectUri,
    publicOrigin
  };

  const dependencies = {
    configuration,
    client: {} as oidc.Configuration,
    database,
    sessions,
    loginTransactions: pendingTransactions,
    oidcClient
  };
  const handlers = createOidcBffHandlers(dependencies);

  return {
    handlers, dependencies, state, nonce, verifier, csrfToken, tokenResponse,
    authorizationCodeGrant, oidcClient, pendingTransactions, sessions,
    database, storedSession, get createdSession() { return createdSession; }
  };
}

describe("OIDC-backed Node BFF handlers", () => {
  it("starts an authorization-code login with PKCE, state, nonce, and browser binding", async () => {
    const f = setup();
    const base = await openServer(f.handlers);
    const response = await fetch(`${base}/auth/login`, { redirect: "manual" });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin).toBe("https://idp.example.test");
    expect(f.pendingTransactions.create).toHaveBeenCalledOnce();
    const args = vi.mocked(f.pendingTransactions.create).mock.calls[0];
    expect(args?.[0]).toBe(f.state);
    expect(args?.[2]).toEqual({ codeVerifier: f.verifier, nonce: f.nonce });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(getCookies(response)[0]).toContain("__Host-infinyx_oidc_tx=");
  });

  it("consumes the one-time callback transaction and creates a server-side session", async () => {
    const f = setup();
    const base = await openServer(f.handlers);
    const login = await fetch(`${base}/auth/login`, { redirect: "manual" });
    const bindingCookie = getCookies(login)[0]!.split(";")[0]!;
    const previousSessionId = createOpaqueSessionId();
    const callback = await fetch(
      `${base}/auth/callback?state=${f.state}&code=synthetic-code&iss=${encodeURIComponent(issuer)}&returnTo=https%3A%2F%2Fevil.example`,
      { redirect: "manual", headers: { cookie: `${bindingCookie}; __Host-infinyx_session=${previousSessionId}` } }
    );
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe("/");
    expect(f.pendingTransactions.consume).toHaveBeenCalledWith(f.state, bindingCookie.split("=")[1]);
    expect(f.authorizationCodeGrant).toHaveBeenCalledOnce();
    expect(f.database.query).toHaveBeenCalledWith(expect.stringContaining("user_external_identities"), [issuer, "subject-123"]);
    expect(vi.mocked(f.database.query).mock.calls[0]?.[0]).toContain("INNER JOIN user_external_identity_lifecycle");
    expect(vi.mocked(f.database.query).mock.calls[0]?.[0]).toContain("lifecycle.status = 'active'");
    expect(f.sessions.create).toHaveBeenCalledOnce();
    expect(f.sessions.revoke).toHaveBeenCalledWith(previousSessionId);
    expect(f.createdSession).toMatchObject({
      userId,
      issuer,
      subject: "subject-123"
    });
    const cookies = getCookies(callback);
    expect(cookies.some(cookie => cookie.startsWith("__Host-infinyx_session="))).toBe(true);
    expect(cookies.some(cookie => cookie.includes("__Host-infinyx_oidc_tx=") && cookie.includes("Max-Age=0"))).toBe(true);
    expect(callback.headers.get("cache-control")).toBe("no-store");

    const replay = await fetch(
      `${base}/auth/callback?state=${f.state}&code=synthetic-code`,
      { redirect: "manual", headers: { cookie: bindingCookie } }
    );
    expect(replay.status).toBe(401);
    expect(f.sessions.create).toHaveBeenCalledOnce();
  });

  it("denies login when the external identity lifecycle is revoked or missing", async () => {
    const f = setup();
    vi.mocked(f.database.query).mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const base = await openServer(f.handlers);
    const login = await fetch(`${base}/auth/login`, { redirect: "manual" });
    const bindingCookie = getCookies(login)[0]!.split(";")[0]!;
    const callback = await fetch(
      `${base}/auth/callback?state=${f.state}&code=synthetic-code`,
      { redirect: "manual", headers: { cookie: bindingCookie } }
    );
    expect(callback.status).toBe(401);
    expect(f.sessions.create).not.toHaveBeenCalled();
    expect(vi.mocked(f.database.query).mock.calls[0]?.[0]).toContain("INNER JOIN user_external_identity_lifecycle");
    expect(vi.mocked(f.database.query).mock.calls[0]?.[0]).toContain("lifecycle.status = 'active'");
  });

  it("denies login when the internal account is suspended or disabled", async () => {
    const f = setup();
    vi.mocked(f.database.query).mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const base = await openServer(f.handlers);
    const login = await fetch(`${base}/auth/login`, { redirect: "manual" });
    const bindingCookie = getCookies(login)[0]!.split(";")[0]!;
    const callback = await fetch(
      `${base}/auth/callback?state=${f.state}&code=synthetic-code`,
      { redirect: "manual", headers: { cookie: bindingCookie } }
    );
    expect(callback.status).toBe(401);
    expect(f.sessions.create).not.toHaveBeenCalled();
    const sql = vi.mocked(f.database.query).mock.calls[0]?.[0] as string;
    expect(sql).toContain("INNER JOIN user_account_security");
    expect(sql).toContain("account_security.status = 'active'");
    expect(sql).toContain("user_account_session_revocation_outbox");
  });

  it("returns only the internal user and CSRF token, never OAuth tokens", async () => {
    const f = setup();
    const base = await openServer(f.handlers);
    const response = await fetch(`${base}/api/session`, {
      headers: { cookie: "__Host-infinyx_session=" + createOpaqueSessionId() }
    });
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ authenticated: true, userId, csrfToken: f.csrfToken });
    expect(JSON.stringify(body)).not.toContain("synthetic-access-token");
    expect(JSON.stringify(body)).not.toContain("synthetic-refresh-token");
    expect(f.sessions.touch).toHaveBeenCalledOnce();
  });

  it("requires same-origin CSRF proof for logout and revokes locally before upstream best effort", async () => {
    const f = setup();
    const base = await openServer(f.handlers);
    const sessionId = createOpaqueSessionId();
    const denied = await fetch(`${base}/auth/logout`, {
      method: "POST",
      headers: { cookie: `__Host-infinyx_session=${sessionId}` }
    });
    expect(denied.status).toBe(403);
    expect(f.sessions.revoke).not.toHaveBeenCalled();

    const allowed = await fetch(`${base}/auth/logout`, {
      method: "POST",
      headers: {
        cookie: `__Host-infinyx_session=${sessionId}`,
        origin: publicOrigin,
        "x-infinyx-csrf": f.csrfToken
      }
    });
    expect(allowed.status).toBe(204);
    expect(f.sessions.revoke).toHaveBeenCalledWith(sessionId);
    expect(f.oidcClient.tokenRevocation).toHaveBeenCalledWith({}, "synthetic-refresh-token");
    expect(getCookies(allowed).some(cookie => cookie.includes("Max-Age=0"))).toBe(true);
  });

  it("refreshes access tokens only through the server-side session store", async () => {
    const f = setup();
    const accessToken = await (await import("./oidc-bff.js")).getSessionAccessToken(
      createOpaqueSessionId(),
      f.dependencies
    );
    expect(accessToken).toBe("refreshed-access-token");
    expect(f.oidcClient.refreshTokenGrant).toHaveBeenCalledWith(
      f.dependencies.client,
      "synthetic-refresh-token"
    );
  });

  it("fails closed when the provider identity has no internal-user mapping", async () => {
    const f = setup();
    vi.mocked(f.database.query).mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const base = await openServer(f.handlers);
    const login = await fetch(`${base}/auth/login`, { redirect: "manual" });
    const bindingCookie = getCookies(login)[0]!.split(";")[0]!;
    const callback = await fetch(
      `${base}/auth/callback?state=${f.state}&code=synthetic-code`,
      { redirect: "manual", headers: { cookie: bindingCookie } }
    );
    expect(callback.status).toBe(401);
    expect(f.sessions.create).not.toHaveBeenCalled();
  });
});
