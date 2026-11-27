import { generateKeyPairSync, sign } from "node:crypto";
import type { Request, Response } from "express";
import { describe, expect, it } from "vitest";
import {
  AuthenticationError,
  createAuthenticatedPrincipalResolver,
  createBearerAuthMiddleware,
  createJwtPrincipalVerifier,
  createPrincipalMemoryScope,
  getAuthenticatedPrincipal,
  isAuthenticatedPrincipal,
  isVerifiedExternalIdentity
} from "./authenticated-principal.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" }
});
const issuer = "https://identity.infinyx.test";
const audience = "infinyx-api";
const now = 1_800_000_000;
const verify = createJwtPrincipalVerifier({
  issuer,
  audience,
  publicKeyPem: publicKey,
  now: () => now
});
const internalUserId = "10000000-0000-4000-8000-000000000001";
const resolvePrincipal = createAuthenticatedPrincipalResolver(
  (_issuer, subject) => subject === "unknown-user" ? null : internalUserId
);

function token(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = [
    encode({ alg: "RS256", typ: "JWT", ...header }),
    encode({ iss: issuer, aud: audience, sub: "provider-subject-1", exp: now + 300, ...claims })
  ].join(".");
  return `${signingInput}.${sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url")}`;
}

describe("createJwtPrincipalVerifier", () => {
  it("verifies external identity provenance without creating tenant authorization", () => {
    const identity = verify(token({ tenant_id: "attacker-selected-tenant", role: "owner" }));
    expect(identity).toMatchObject({
      issuer,
      subject: "provider-subject-1",
      audience: [audience],
      expiresAt: now + 300
    });
    expect("tenantId" in identity).toBe(false);
    expect(isVerifiedExternalIdentity(identity)).toBe(true);
    expect(Object.isFrozen(identity)).toBe(true);
  });

  it("does not require or trust a tenant claim", () => {
    expect(verify(token({ tenant_id: undefined })).subject).toBe("provider-subject-1");
  });

  it("rejects an invalid signature, issuer, audience, expiry, nbf and algorithm", () => {
    const valid = token();
    const [header, payload] = valid.split(".");
    expect(() => verify(`${header}.${payload}.ZmFrZQ`)).toThrow(AuthenticationError);
    expect(() => verify(token({ iss: "https://untrusted.example" }))).toThrow(AuthenticationError);
    expect(() => verify(token({ aud: "another-api" }))).toThrow(AuthenticationError);
    expect(() => verify(token({ exp: now - 6 }))).toThrow(AuthenticationError);
    expect(() => verify(token({ nbf: now + 6 }))).toThrow(AuthenticationError);
    expect(() => verify(token({}, { alg: "HS256" }))).toThrow(AuthenticationError);
  });

  it("rejects malformed, oversized and invalid subject inputs", () => {
    expect(() => verify("not-a-jwt")).toThrow(AuthenticationError);
    expect(() => verify("x".repeat(16_385))).toThrow(AuthenticationError);
    expect(() => verify(token({ sub: "  " }))).toThrow(AuthenticationError);
    expect(() => verify(token({ sub: "bad\\u0000subject" }))).toThrow(AuthenticationError);
  });

  it("rejects invalid verifier configuration", () => {
    expect(() => createJwtPrincipalVerifier({ issuer: " ", audience, publicKeyPem: publicKey }))
      .toThrow(TypeError);
    expect(() => createJwtPrincipalVerifier({
      issuer, audience, publicKeyPem: publicKey, clockToleranceSeconds: 301
    })).toThrow(TypeError);
  });
});

describe("internal principal resolution", () => {
  it("maps a verified issuer and subject to the stable internal user ID", () => {
    const principal = resolvePrincipal(verify(token()));
    expect(principal).toMatchObject({
      userId: internalUserId,
      issuer,
      subject: "provider-subject-1",
      audience: [audience]
    });
    expect("tenantId" in principal).toBe(false);
    expect(isAuthenticatedPrincipal(principal)).toBe(true);
  });

  it("fails closed for unknown identities and forged external identity objects", () => {
    expect(() => resolvePrincipal(verify(token({ sub: "unknown-user" })))
      .toThrow(AuthenticationError);
    expect(() => resolvePrincipal({
      issuer, subject: "provider-subject-1", audience: [audience], expiresAt: now + 10
    })).toThrow(AuthenticationError);
  });

  it("supports an asynchronous identity directory", async () => {
    const asyncResolver = createAuthenticatedPrincipalResolver(async () => internalUserId);
    await expect(asyncResolver(verify(token()))).resolves.toMatchObject({ userId: internalUserId });
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
    createBearerAuthMiddleware(verify, resolvePrincipal)(request, response, () => { nextCalled = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { statusCode, body, nextCalled, locals, request };
  }

  it("stores only the mapped internal principal after verification", async () => {
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

  it("returns 401 for unknown mapped identities", async () => {
    const result = await invoke(`Bearer ${token({ sub: "unknown-user" })}`);
    expect(result.statusCode).toBe(401);
    expect(result.nextCalled).toBe(false);
  });
});

describe("personal memory scope", () => {
  it("uses the stable internal user ID and has no tenant dimension", () => {
    const principal = resolvePrincipal(verify(token()));
    expect(createPrincipalMemoryScope(principal, "assistant")).toEqual({
      scope: "personal",
      userId: internalUserId,
      moduleId: "assistant"
    });
  });

  it("rejects fabricated principals and invalid module identifiers", () => {
    expect(() => createPrincipalMemoryScope({
      userId: internalUserId, issuer, subject: "provider-subject-1",
      audience: [audience], expiresAt: now + 100
    }, "assistant")).toThrow(AuthenticationError);
    expect(() => createPrincipalMemoryScope(resolvePrincipal(verify(token())), "bad\\u0000module"))
      .toThrow(AuthenticationError);
  });

  it("does not expose an unverified request-local value as authenticated", () => {
    const request = {
      res: { locals: { authenticatedPrincipal: { userId: internalUserId } } }
    } as unknown as Request;
    expect(getAuthenticatedPrincipal(request)).toBeNull();
  });
});
