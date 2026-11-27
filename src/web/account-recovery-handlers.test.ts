import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { Server } from "node:http";
import type * as oidc from "openid-client";
import { createBffHttpServer } from "./bff-server.js";
import { createOpaqueSessionId } from "./session-crypto.js";
import { createAccountRecoveryHandlers } from "./account-recovery-handlers.js";
import type { OidcBffClient, OidcBffConfiguration } from "./oidc-bff.js";
import { recoverSuspendedAccount } from "./account-recovery-workflow.js";
import { completeAccountSessionRevocation } from "./account-session-revocation.js";

vi.mock("./account-recovery-workflow.js", () => ({
  recoverSuspendedAccount: vi.fn()
}));
vi.mock("./account-session-revocation.js", () => ({
  completeAccountSessionRevocation: vi.fn()
}));

const servers: Server[] = [];
const issuer = "https://identity.infinyx.test";
const publicOrigin = "https://app.infinyx.test";
const userId = "10000000-0000-4000-8000-000000000001";
const outboxId = "20000000-0000-4000-8000-000000000001";

async function openServer(handlers: ReturnType<typeof createAccountRecoveryHandlers>): Promise<string> {
  const notFound = (_request: unknown, response: import("node:http").ServerResponse) => {
    response.statusCode = 404;
    response.end();
  };
  const server = createBffHttpServer({
    startLogin: notFound, handleCallback: notFound, getSession: notFound, logout: notFound,
    startReauth: notFound, handleReauthCallback: notFound,
    startUnlinkReauth: notFound, handleUnlinkReauthCallback: notFound,
    unlinkIdentity: notFound, startLink: notFound, handleLinkCallback: notFound,
    ...handlers
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  return `http://127.0.0.1:${address.port}`;
}

function cookies(response: Response): string[] {
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
  const verifier = "A".repeat(64);
  const browserBinding = createOpaqueSessionId();
  const now = new Date();
  let authTime = Math.floor(now.getTime() / 1000);
  const payload = { codeVerifier: verifier, nonce };
  const authorizationCodeGrant = vi.fn(async (_config: unknown, _url: URL, checks: unknown) => {
    expect(checks).toEqual({
      expectedState: state, expectedNonce: nonce,
      pkceCodeVerifier: verifier, idTokenExpected: true
    });
    return { claims: () => ({ iss: issuer, sub: "existing-active-subject", auth_time: authTime }) };
  });
  const oidcClient = {
    randomState: () => state,
    randomNonce: () => nonce,
    randomPKCECodeVerifier: () => verifier,
    calculatePKCECodeChallenge: async () => "synthetic-challenge",
    buildAuthorizationUrl: (_config: unknown, params: Record<string, string>) => {
      expect(params).toMatchObject({
        redirect_uri: `${publicOrigin}/auth/account-recovery/callback`,
        prompt: "login", max_age: "0", code_challenge_method: "S256",
        state, nonce
      });
      return new URL("https://idp.example.test/authorize");
    },
    authorizationCodeGrant
  } as unknown as OidcBffClient;
  const recoveryTransactions = {
    create: vi.fn(async () => undefined),
    consume: vi.fn(async () => ({ transactionId: "30000000-0000-4000-8000-000000000001", payload }))
  };
  const configuration: OidcBffConfiguration = {
    issuer, clientId: "infinyx-web", clientSecret: "synthetic-secret",
    redirectUri: `${publicOrigin}/auth/callback`, publicOrigin
  };
  const handlers = createAccountRecoveryHandlers({
    configuration, client: {} as oidc.Configuration, oidcClient,
    database: {} as Pool, sessions: {} as never,
    recoveryTransactions: recoveryTransactions as never,
    now: () => now
  });
  return {
    handlers, state, browserBinding, recoveryTransactions, authorizationCodeGrant,
    setAuthTime: (value: number) => { authTime = value; }
  };
}

describe("OIDC account recovery handlers", () => {
  beforeEach(() => {
    vi.mocked(recoverSuspendedAccount).mockReset();
    vi.mocked(completeAccountSessionRevocation).mockReset();
    vi.mocked(recoverSuspendedAccount).mockResolvedValue({
      outcome: "recovered", userId, outboxId
    });
    vi.mocked(completeAccountSessionRevocation).mockResolvedValue(true);
  });

  it("requires the exact Origin and starts a short-lived PKCE recovery challenge", async () => {
    const f = setup();
    const base = await openServer(f.handlers);
    const denied = await fetch(`${base}/account/recovery/start`, { method: "POST" });
    expect(denied.status).toBe(403);
    expect(f.recoveryTransactions.create).not.toHaveBeenCalled();

    const response = await fetch(`${base}/account/recovery/start`, {
      method: "POST", headers: { origin: publicOrigin }, redirect: "manual"
    });
    expect(response.status).toBe(302);
    expect(f.recoveryTransactions.create).toHaveBeenCalledOnce();
    expect(f.recoveryTransactions.create.mock.calls[0]?.[0]).toBe(f.state);
    expect(f.recoveryTransactions.create.mock.calls[0]?.[1]).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(new URL(response.headers.get("location")!).origin).toBe("https://idp.example.test");
    expect(cookies(response)[0]).toContain("__Host-infinyx_identity_tx=");
  });

  it("recovers only after a fresh validated OIDC identity and then revokes sessions", async () => {
    const f = setup();
    const base = await openServer(f.handlers);
    const start = await fetch(`${base}/account/recovery/start`, {
      method: "POST", headers: { origin: publicOrigin }, redirect: "manual"
    });
    const bindingCookie = cookies(start)[0]!.split(";")[0]!;
    const callback = await fetch(
      `${base}/auth/account-recovery/callback?state=${f.state}&code=synthetic-code`,
      { headers: { cookie: bindingCookie }, redirect: "manual" }
    );
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe("/auth/login");
    expect(f.recoveryTransactions.consume).toHaveBeenCalledWith(f.state, bindingCookie.split("=")[1]);
    expect(f.authorizationCodeGrant).toHaveBeenCalledOnce();
    expect(recoverSuspendedAccount).toHaveBeenCalledWith(
      expect.anything(), issuer, "existing-active-subject", expect.any(String)
    );
    expect(completeAccountSessionRevocation).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), userId, outboxId
    );
    expect(cookies(callback).some(cookie => cookie.includes("__Host-infinyx_session=") && cookie.includes("Max-Age=0"))).toBe(true);
  });

  it("rejects stale authentication time before any account state transition", async () => {
    const f = setup();
    f.setAuthTime(Math.floor(Date.now() / 1000) - 301);
    const base = await openServer(f.handlers);
    const start = await fetch(`${base}/account/recovery/start`, {
      method: "POST", headers: { origin: publicOrigin }, redirect: "manual"
    });
    const bindingCookie = cookies(start)[0]!.split(";")[0]!;
    const callback = await fetch(
      `${base}/auth/account-recovery/callback?state=${f.state}&code=synthetic-code`,
      { headers: { cookie: bindingCookie }, redirect: "manual" }
    );
    expect(callback.status).toBe(401);
    expect(recoverSuspendedAccount).not.toHaveBeenCalled();
  });

  it("keeps the account inaccessible when session revocation is pending", async () => {
    vi.mocked(completeAccountSessionRevocation).mockResolvedValue(false);
    const f = setup();
    const base = await openServer(f.handlers);
    const start = await fetch(`${base}/account/recovery/start`, {
      method: "POST", headers: { origin: publicOrigin }, redirect: "manual"
    });
    const bindingCookie = cookies(start)[0]!.split(";")[0]!;
    const callback = await fetch(
      `${base}/auth/account-recovery/callback?state=${f.state}&code=synthetic-code`,
      { headers: { cookie: bindingCookie }, redirect: "manual" }
    );
    expect(callback.status).toBe(503);
    expect(callback.headers.get("location")).toBeNull();
  });

  it("returns a generic denial when the proven identity is not eligible", async () => {
    vi.mocked(recoverSuspendedAccount).mockResolvedValue({ outcome: "denied" });
    const f = setup();
    const base = await openServer(f.handlers);
    const start = await fetch(`${base}/account/recovery/start`, {
      method: "POST", headers: { origin: publicOrigin }, redirect: "manual"
    });
    const bindingCookie = cookies(start)[0]!.split(";")[0]!;
    const callback = await fetch(
      `${base}/auth/account-recovery/callback?state=${f.state}&code=synthetic-code`,
      { headers: { cookie: bindingCookie }, redirect: "manual" }
    );
    expect(callback.status).toBe(401);
    expect(await callback.json()).toEqual({ error: "account_recovery_unavailable" });
    expect(completeAccountSessionRevocation).not.toHaveBeenCalled();
  });
});
