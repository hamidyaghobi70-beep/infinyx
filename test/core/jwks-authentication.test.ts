import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { generateKeyPairSync, sign } from "node:crypto";
import { createAsyncBearerAuthMiddleware, createJwksJwtPrincipalVerifier } from "../../src/core/authenticated-principal.js";
import { JwksKeyResolver } from "../../src/core/jwks-key-resolver.js";
import { createApp } from "../../src/api/app.js";

const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = pair.publicKey.export({ format: "jwk" });
const issuer = "https://id.example.test/realms/infinyx";
const audience = "infinyx-api";
const claims = { iss: issuer, aud: audience, sub: "user-1", tenant_id: "tenant-1", exp: 1_900_000_000 };
function makeToken(payload: Record<string, unknown> = claims, kid = "key-1") {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = encode({ alg: "RS256", typ: "JWT", kid }) + "." + encode(payload);
  return input + "." + sign("RSA-SHA256", Buffer.from(input), pair.privateKey).toString("base64url");
}
function resolver() {
  return new JwksKeyResolver({
    jwksUrl: "https://id.example.test/realms/infinyx/protocol/openid-connect/certs",
    fetcher: async () => new Response(JSON.stringify({ keys: [{ ...jwk, kid: "key-1", use: "sig", alg: "RS256" }] }), { status: 200 })
  });
}

describe("JWKS-backed JWT authentication", () => {
  it("verifies signature and signed identity claims through the configured JWKS", async () => {
    const verify = createJwksJwtPrincipalVerifier({ issuer, audience, now: () => 1_800_000_000 }, resolver());
    const principal = await verify(makeToken());
    expect(principal).toMatchObject({ subject: "user-1", tenantId: "tenant-1", issuer, audience: [audience] });
  });

  it("rejects wrong issuer, audience, expiry, unknown kid and bad signatures", async () => {
    const verify = createJwksJwtPrincipalVerifier({ issuer, audience, now: () => 1_800_000_000 }, resolver());
    await expect(verify(makeToken({ ...claims, iss: "https://attacker.test" }))).rejects.toThrow();
    await expect(verify(makeToken({ ...claims, aud: "other" }))).rejects.toThrow();
    await expect(verify(makeToken({ ...claims, exp: 1_700_000_000 }))).rejects.toThrow();
    await expect(verify(makeToken(claims, "unknown"))).rejects.toThrow();
    await expect(verify(makeToken(claims).replace(/.$/, "A"))).rejects.toThrow();
  });

  it("exposes identity only after async bearer verification succeeds", async () => {
    const verify = createJwksJwtPrincipalVerifier({ issuer, audience, now: () => 1_800_000_000 }, resolver());
    const app = createApp(() => true, createAsyncBearerAuthMiddleware(verify));
    const accepted = await request(app).get("/v1/identity").set("Authorization", "Bearer " + makeToken());
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ subject: "user-1", tenantId: "tenant-1" });
    const rejected = await request(app).get("/v1/identity").set("Authorization", "Bearer " + makeToken({ ...claims, tenant_id: "" }));
    expect(rejected.status).toBe(401);
    expect(rejected.body).toEqual({ error: "unauthorized" });
  });

  it("fails closed when the JWKS provider is unavailable", async () => {
    const keyResolver = new JwksKeyResolver({ jwksUrl: "https://id.example.test/jwks", fetcher: vi.fn(async () => new Response("", { status: 503 })) });
    const verify = createJwksJwtPrincipalVerifier({ issuer, audience }, keyResolver);
    const app = createApp(() => true, createAsyncBearerAuthMiddleware(verify));
    const response = await request(app).get("/v1/identity").set("Authorization", "Bearer " + makeToken());
    expect(response.status).toBe(401);
  });
});
