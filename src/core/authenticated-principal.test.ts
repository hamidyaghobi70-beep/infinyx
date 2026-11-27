import { generateKeyPairSync, sign } from "node:crypto";
import type { Request, Response } from "express";
import { describe, expect, it } from "vitest";
import {
  AuthenticationError,
  createBearerAuthMiddleware,
  createJwtPrincipalVerifier,
  createPrincipalMemoryScope,
  getAuthenticatedPrincipal,
  isAuthenticatedPrincipal
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

function token(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = [
    encode({ alg: "RS256", typ: "JWT", ...header }),
    encode({
      iss: issuer,
      aud: audience,
      sub: "user-1",
      tenant_id: "tenant-a",
      exp: now + 300,
      ...claims
    })
  ].join(".");
  return `${signingInput}.${sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url")}`;
}

describe("createJwtPrincipalVerifier", () => {
  it("accepts a valid RS256 token and returns a verified immutable principal", () => {
    const principal = verify(token());
    expect(principal).toMatchObject({
      subject: "user-1",
      tenantId: "tenant-a",
      issuer,
      audience: [audience],
      expiresAt: now + 300
    });
    expect(Object.isFrozen(principal)).toBe(true);
    expect(isAuthenticatedPrincipal(principal)).toBe(true);
  });

  it("rejects a token with an invalid signature", () => {
    const valid = token();
    const [header, payload] = valid.split(".");
    expect(() => verify(`${header}.${payload}.ZmFrZQ`)).toThrow(AuthenticationError);
  });

  it("rejects a token with the wrong issuer", () => {
    expect(() => verify(token({ iss: "https://untrusted.example" }))).toThrow(AuthenticationError);
  });

  it("rejects a token with an audience that does not match", () => {
    expect(() => verify(token({ aud: "another-api" }))).toThrow(AuthenticationError);
  });

  it("accepts the expected audience in a valid audience array", () => {
    expect(verify(token({ aud: ["another-api", audience] })).audience).toEqual(["another-api", audience]);
  });

  it("rejects expired tokens outside the configured clock tolerance", () => {
    expect(() => verify(token({ exp: now - 6 }))).toThrow(AuthenticationError);
  });

  it("applies the configured clock tolerance to expiration", () => {
    expect(verify(token({ exp: now - 4 })).subject).toBe("user-1");
  });

  it("rejects tokens whose nbf is in the future beyond tolerance", () => {
    expect(() => verify(token({ nbf: now + 6 }))).toThrow(AuthenticationError);
  });

  it("rejects unsupported signing algorithms", () => {
    expect(() => verify(token({}, { alg: "HS256" }))).toThrow(AuthenticationError);
  });

  it("rejects missing tenant and invalid subject claims", () => {
    expect(() => verify(token({ tenant_id: undefined }))).toThrow(AuthenticationError);
    expect(() => verify(token({ sub: "  " }))).toThrow(AuthenticationError);
  });

  it("rejects control characters in identity claims", () => {
    expect(() => verify(token({ sub: "user\u0000one" }))).toThrow(AuthenticationError);
  });

  it("rejects malformed and oversized token inputs", () => {
    expect(() => verify("not-a-jwt")).toThrow(AuthenticationError);
    expect(() => verify("x".repeat(16_385))).toThrow(AuthenticationError);
  });

  it("rejects invalid verifier configuration", () => {
    expect(() => createJwtPrincipalVerifier({
      issuer: " ",
      audience,
      publicKeyPem: publicKey
    })).toThrow(TypeError);
    expect(() => createJwtPrincipalVerifier({
      issuer,
      audience,
      publicKeyPem: publicKey,
      clockToleranceSeconds: 301
    })).toThrow(TypeError);
  });
});

describe("bearer middleware", () => {
  function invoke(header: string | undefined) {
    let statusCode = 200;
    let body: unknown;
    let nextCalled = false;
    const locals: Record<string, unknown> = {};
    const request = {
      header: (name: string) => name.toLowerCase() === "authorization" ? header : undefined
    } as Request;
    const response = {
      locals,
      status(code: number) { statusCode = code; return this; },
      json(value: unknown) { body = value; return this; }
    } as unknown as Response;
    createBearerAuthMiddleware(verify)(request, response, () => { nextCalled = true; });
    return { statusCode, body, nextCalled, locals, request };
  }

  it("accepts a valid Bearer header and stores the verified principal", () => {
    const result = invoke(`Bearer ${token()}`);
    expect(result.nextCalled).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(isAuthenticatedPrincipal(result.locals.authenticatedPrincipal)).toBe(true);
    expect(getAuthenticatedPrincipal(result.request)).toBe(result.locals.authenticatedPrincipal);
  });

  it.each([undefined, "", "Basic abc", "Bearer", "Bearer token with-space", "Bearer\ttoken"])(
    "rejects malformed authorization header: %s",
    (header) => {
      const result = invoke(header);
      expect(result.statusCode).toBe(401);
      expect(result.body).toEqual({ error: "unauthorized" });
      expect(result.nextCalled).toBe(false);
    }
  );

  it("returns 401 when token verification fails", () => {
    const result = invoke("Bearer invalid.token.value");
    expect(result.statusCode).toBe(401);
    expect(result.nextCalled).toBe(false);
  });
});

describe("tenant-scoped memory context", () => {
  it("derives a scope from the verified principal's tenant and actor", () => {
    const principal = verify(token({ tenant_id: "tenant-a", sub: "alice" }));
    expect(createPrincipalMemoryScope(principal, "assistant")).toEqual({
      tenantId: "tenant-a",
      actorId: "alice",
      moduleId: "assistant"
    });
  });

  it("keeps scopes distinct across tenants", () => {
    const tenantA = createPrincipalMemoryScope(verify(token({ tenant_id: "tenant-a" })), "assistant");
    const tenantB = createPrincipalMemoryScope(verify(token({ tenant_id: "tenant-b" })), "assistant");
    expect(tenantA.tenantId).not.toBe(tenantB.tenantId);
  });

  it("rejects fabricated principals and invalid module identifiers", () => {
    expect(() => createPrincipalMemoryScope({
      subject: "user-1",
      tenantId: "tenant-a",
      issuer,
      audience: [audience],
      expiresAt: now + 100
    }, "assistant")).toThrow(AuthenticationError);
    expect(() => createPrincipalMemoryScope(verify(token()), "bad\u0000module")).toThrow(AuthenticationError);
  });

  it("does not expose an unverified request-local value as an authenticated principal", () => {
    const request = {
      res: { locals: { authenticatedPrincipal: { subject: "forged" } } }
    } as unknown as Request;
    expect(getAuthenticatedPrincipal(request)).toBeNull();
  });
});
