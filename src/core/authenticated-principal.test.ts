import { generateKeyPairSync, sign } from "node:crypto";
import type { Request, Response } from "express";
import { describe, expect, it } from "vitest";
import {
  AuthenticationError,
  createAuthenticatedPrincipalResolver,
  createBearerAuthMiddleware,
  createOidcJwksPrincipalVerifier,
  createPrincipalMemoryScope,
  getAuthenticatedPrincipal,
  isAuthenticatedPrincipal,
  isVerifiedExternalIdentity
} from "./authenticated-principal.js";

const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const rotatedPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const issuer = "https://identity.infinyx.test";
const audience = "infinyx-api";
const authorizedParty = "infinyx-web";
const now = 1_800_000_000;
const internalUserId = "10000000-0000-4000-8000-000000000001";

function jwk(keyPair: typeof pair, kid: string) {
  return { ...keyPair.publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" };
}

function token(
  keyPair: typeof pair = pair,
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {}
) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = [
    encode({ alg: "RS256", typ: "JWT", kid: "key-1", ...header }),
    encode({
      iss: issuer, aud: audience, sub: "provider-subject-1",
      exp: now + 300, iat: now - 10, typ: "Bearer", azp: authorizedParty, ...claims
    })
  ].join(".");
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), keyPair.privateKey).toString("base64url")}`;
}

function makeVerifier(options: {
  keys?: unknown[];
  discoveryIssuer?: string;
  fetcher?: typeof fetch;
  now?: () => number;
} = {}) {
  const fetcher = options.fetcher ?? (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/.well-known/openid-configuration")) {
      return new Response(JSON.stringify({
        issuer: options.discoveryIssuer ?? issuer,
        jwks_uri: `${issuer}/protocol/openid-connect/certs`
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ keys: options.keys ?? [jwk(pair, "key-1")] }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  });
  const verifier = createOidcJwksPrincipalVerifier({
    issuer, audience, authorizedParties: [authorizedParty], accessTokenType: "Bearer",
    now: options.now ?? (() => now), fetcher
  });
  return { verifier, fetcher };
}

describe("OIDC discovery and JWKS token verifier", () => {
  it("verifies access-token provenance without creating tenant authorization", async () => {
    const { verifier } = makeVerifier();
    const identity = await verifier(token(pair, {
      tenant_id: "attacker-selected-tenant", role: "owner"
    }));
    expect(identity).toMatchObject({
      issuer, subject: "provider-subject-1", audience: [audience], expiresAt: now + 300
    });
    expect("tenantId" in identity).toBe(false);
    expect(isVerifiedExternalIdentity(identity)).toBe(true);
    expect(Object.isFrozen(identity)).toBe(true);
  });

  it("rejects wrong issuer, audience, access-token type, client, expiry, nbf and iat", async () => {
    const { verifier } = makeVerifier();
    for (const claims of [
      { iss: "https://untrusted.example" },
      { aud: "another-api" },
      { typ: "ID" },
      { azp: "another-client" },
      { exp: now - 6 },
      { nbf: now + 6 },
      { iat: now + 6 },
      { iat: now + 400 }
    ]) {
      await expect(verifier(token(pair, claims))).rejects.toBeInstanceOf(AuthenticationError);
    }
  });

  it("rejects unsupported algorithms and token-supplied key locations", async () => {
    const { verifier } = makeVerifier();
    for (const header of [
      { alg: "HS256" }, { jku: "https://attacker.example/keys" },
      { x5u: "https://attacker.example/cert" }, { jwk: jwk(pair, "attacker") },
      { crit: ["b64"] }, { kid: "../key" }
    ]) {
      await expect(verifier(token(pair, {}, header))).rejects.toBeInstanceOf(AuthenticationError);
    }
  });

  it("rejects invalid signatures, malformed tokens and invalid subjects", async () => {
    const { verifier } = makeVerifier();
    const valid = token();
    const [header, payload] = valid.split(".");
    await expect(verifier(`${header}.${payload}.ZmFrZQ`)).rejects.toBeInstanceOf(AuthenticationError);
    await expect(verifier("not-a-jwt")).rejects.toBeInstanceOf(AuthenticationError);
    await expect(verifier("x".repeat(16_385))).rejects.toBeInstanceOf(AuthenticationError);
    await expect(verifier(token(pair, { sub: "  " }))).rejects.toBeInstanceOf(AuthenticationError);
    await expect(verifier(token(pair, { sub: "bad\u0000subject" }))).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("refreshes trusted JWKS once to accept a rotated signing key", async () => {
    const nextKey = jwk(rotatedPair, "key-2");
    let jwksCalls = 0;
    const fetcher: typeof fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) {
        return new Response(JSON.stringify({
          issuer, jwks_uri: `${issuer}/protocol/openid-connect/certs`
        }), { status: 200 });
      }
      jwksCalls++;
      return new Response(JSON.stringify({
        keys: jwksCalls === 1 ? [jwk(pair, "key-1")] : [jwk(pair, "key-1"), nextKey]
      }), { status: 200 });
    };
    const { verifier } = makeVerifier({ fetcher });
    await expect(verifier(token(rotatedPair, {}, { kid: "key-2" })))
      .resolves.toMatchObject({ subject: "provider-subject-1" });
    expect(jwksCalls).toBe(2);
  });

  it("fails closed on discovery mismatch, unavailable JWKS and unresolved kid", async () => {
    const mismatch = makeVerifier({ discoveryIssuer: "https://other.example" });
    await expect(mismatch.verifier(token())).rejects.toBeInstanceOf(AuthenticationError);

    const unavailable = makeVerifier({ fetcher: async () => new Response("", { status: 503 }) });
    await expect(unavailable.verifier(token())).rejects.toBeInstanceOf(AuthenticationError);

    const unknown = makeVerifier();
    await expect(unknown.verifier(token(pair, {}, { kid: "missing-key" })))
      .rejects.toBeInstanceOf(AuthenticationError);
  });

  it("rejects invalid verifier configuration", () => {
    expect(() => createOidcJwksPrincipalVerifier({
      issuer: "http://identity.infinyx.test", audience, authorizedParties: [authorizedParty], accessTokenType: "Bearer"
    })).toThrow(TypeError);
    expect(() => createOidcJwksPrincipalVerifier({
      issuer, audience: " ", authorizedParties: [authorizedParty], accessTokenType: "Bearer"
    })).toThrow(TypeError);
    expect(() => createOidcJwksPrincipalVerifier({
      issuer, audience, authorizedParties: [], accessTokenType: "Bearer"
    })).toThrow(TypeError);
    expect(() => createOidcJwksPrincipalVerifier({
      issuer, audience, authorizedParties: [authorizedParty], accessTokenType: "Bearer", cacheTtlMs: 99
    })).toThrow(TypeError);
  });
});

describe("internal principal resolution", () => {
  async function identity() {
    return makeVerifier().verifier(token());
  }

  it("maps a verified issuer and subject to the stable internal user ID", async () => {
    const resolvePrincipal = createAuthenticatedPrincipalResolver(
      (_issuer, subject) => subject === "unknown-user" ? null : internalUserId
    );
    const principal = resolvePrincipal(await identity());
    expect(principal).toMatchObject({
      userId: internalUserId, issuer, subject: "provider-subject-1", audience: [audience]
    });
    expect("tenantId" in principal).toBe(false);
    expect(isAuthenticatedPrincipal(principal)).toBe(true);
  });

  it("fails closed for unknown identities and forged external identity objects", async () => {
    const resolver = createAuthenticatedPrincipalResolver(() => null);
    const verifiedIdentity = await identity();
    expect(() => resolver(verifiedIdentity)).toThrow(AuthenticationError);
    expect(() => createAuthenticatedPrincipalResolver(() => internalUserId)({
      issuer, subject: "provider-subject-1", audience: [audience], expiresAt: now + 10
    })).toThrow(AuthenticationError);
  });

  it("supports an asynchronous identity directory", async () => {
    const resolver = createAuthenticatedPrincipalResolver(async () => internalUserId);
    await expect(resolver(await identity())).resolves.toMatchObject({ userId: internalUserId });
  });
});

describe("bearer middleware", () => {
  async function invoke(header: string | undefined) {
    let statusCode = 200;
    let body: unknown;
    let nextCalled = false;
    const locals: Record<string, unknown> = {};
    const response = {
      locals,
      status(code: number) { statusCode = code; return this; },
      json(value: unknown) { body = value; return this; }
    } as unknown as Response;
    const request = {
      header: (name: string) => name.toLowerCase() === "authorization" ? header : undefined,
      res: response
    } as Request;
    const resolver = createAuthenticatedPrincipalResolver(() => internalUserId);
    createBearerAuthMiddleware(makeVerifier().verifier, resolver)(request, response, () => {
      nextCalled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { statusCode, body, nextCalled, locals, request };
  }

  it("stores only the mapped internal principal after asynchronous verification", async () => {
    const result = await invoke(`Bearer ${token()}`);
    expect(result.nextCalled).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(isAuthenticatedPrincipal(result.locals.authenticatedPrincipal)).toBe(true);
    expect(getAuthenticatedPrincipal(result.request)).toBe(result.locals.authenticatedPrincipal);
  });

  it.each([undefined, "", "Basic abc", "Bearer", "Bearer token with-space", "Bearer\\ttoken"])(
    "rejects malformed authorization header: %s",
    async (header) => {
      const result = await invoke(header);
      expect(result.statusCode).toBe(401);
      expect(result.body).toEqual({ error: "unauthorized" });
      expect(result.nextCalled).toBe(false);
    }
  );

  it("returns 401 for invalid access tokens", async () => {
    const result = await invoke(`Bearer ${token(pair, { azp: "untrusted-client" })}`);
    expect(result.statusCode).toBe(401);
    expect(result.nextCalled).toBe(false);
  });
});

describe("personal memory scope", () => {
  it("uses the stable internal user ID and has no tenant dimension", async () => {
    const resolver = createAuthenticatedPrincipalResolver(() => internalUserId);
    const principal = resolver(await identityForMemory());
    expect(createPrincipalMemoryScope(principal, "assistant")).toEqual({
      scope: "personal", userId: internalUserId, moduleId: "assistant"
    });
  });

  it("rejects fabricated principals and invalid module identifiers", async () => {
    const resolver = createAuthenticatedPrincipalResolver(() => internalUserId);
    const principal = resolver(await identityForMemory());
    expect(() => createPrincipalMemoryScope({
      userId: internalUserId, issuer, subject: "provider-subject-1",
      audience: [audience], expiresAt: now + 100
    }, "assistant")).toThrow(AuthenticationError);
    expect(() => createPrincipalMemoryScope(principal, "bad\u0000module"))
      .toThrow(AuthenticationError);
  });

  it("does not expose an unverified request-local value as authenticated", () => {
    const request = {
      res: { locals: { authenticatedPrincipal: { userId: internalUserId } } }
    } as unknown as Request;
    expect(getAuthenticatedPrincipal(request)).toBeNull();
  });
});

async function identityForMemory() {
  return makeVerifier().verifier(token());
}
