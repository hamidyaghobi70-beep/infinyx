import { generateKeyPairSync, sign as signJwt } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import {
  AuthenticationError,
  createBearerAuthMiddleware,
  createJwtPrincipalVerifier,
  createPrincipalMemoryScope
} from "../../src/core/authenticated-principal.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const issuer = "https://issuer.example";
const audience = "infinyx-test";

function makeToken(overrides: Record<string, unknown> = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: issuer, aud: audience, sub: "subject-1", tenant_id: "tenant-1", exp: 2_000,
    ...overrides
  })).toString("base64url");
  const unsigned = header + "." + payload;
  return unsigned + "." + signJwt("RSA-SHA256", Buffer.from(unsigned, "ascii"), privateKey).toString("base64url");
}

describe("authenticated principal validation", () => {
  it("rejects bearer tokens containing whitespace before invoking the verifier", async () => {
    const verifyToken = vi.fn(() => ({ subject: "s", tenantId: "t", issuer, audience: [audience], expiresAt: 2_000 }));
    const app = express();
    app.use(createBearerAuthMiddleware(verifyToken));
    app.get("/", (_request, response) => response.sendStatus(204));
    await request(app).get("/").set("Authorization", "Bearer token with-space").expect(401);
    await request(app).get("/").set("Authorization", "Bearer token\twith-tab").expect(401);
    expect(verifyToken).not.toHaveBeenCalled();
  });

  it("accepts a correctly formatted bearer token", async () => {
    const verifyToken = vi.fn(() => ({ subject: "s", tenantId: "t", issuer, audience: [audience], expiresAt: 2_000 }));
    const app = express();
    app.use(createBearerAuthMiddleware(verifyToken));
    app.get("/", (_request, response) => response.sendStatus(204));
    await request(app).get("/").set("Authorization", "Bearer opaque-token").expect(204);
    expect(verifyToken).toHaveBeenCalledWith("opaque-token");
  });

  it("rejects control characters in signed identity claims", () => {
    const verify = createJwtPrincipalVerifier({ issuer, audience, publicKeyPem, now: () => 1_000 });
    expect(() => verify(makeToken({ sub: "subject\u0001" }))).toThrow(AuthenticationError);
    expect(() => verify(makeToken({ tenant_id: "tenant\u007f" }))).toThrow(AuthenticationError);
  });

  it("rejects control characters in a module memory scope", () => {
    const verify = createJwtPrincipalVerifier({ issuer, audience, publicKeyPem, now: () => 1_000 });
    const principal = verify(makeToken());
    expect(() => createPrincipalMemoryScope(principal, "module\u0000")).toThrow(AuthenticationError);
  });
});
