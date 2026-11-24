import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import type { Request, Response } from "express";
import {
  createBearerAuthMiddleware,
  createJwtPrincipalVerifier
} from "../../src/core/authenticated-principal.js";
import { createAuthenticatedMemoryGateway, getAuthenticatedMemorySession } from "../../src/api/authenticated-memory-gateway.js";
import type { MemoryAddress, PolicyRequest } from "../../src/core/contracts.js";

const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicKeyPem = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
const issuer = "https://idp.integration.test/";
const audience = "infinyx-api";

function signedToken() {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "RS256", typ: "JWT" });
  const payload = encode({
    iss: issuer,
    aud: audience,
    sub: "integration-actor",
    tenant_id: "integration-tenant",
    exp: Math.floor(Date.now() / 1000) + 300
  });
  const input = header + "." + payload;
  return input + "." + sign("RSA-SHA256", Buffer.from(input), keyPair.privateKey).toString("base64url");
}

function responseHarness() {
  const response = {
    locals: {} as Record<string, unknown>,
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; }
  };
  return response as unknown as Response & { locals: Record<string, unknown>; statusCode: number; body: unknown };
}

describe("authenticated memory gateway integration", () => {
  it("verifies a signed bearer token, creates a real guarded capability, and enforces tenant scope", async () => {
    const stored = new Map<string, string>();
    const observedPolicyRequests: PolicyRequest[] = [];
    const auditEvents: unknown[] = [];
    const store = {
      async read(address: MemoryAddress) { return stored.get(address.namespace + ":" + address.key) ?? null; },
      async write(address: MemoryAddress, value: unknown) { stored.set(address.namespace + ":" + address.key, value as string); },
      async delete(address: MemoryAddress) { stored.delete(address.namespace + ":" + address.key); }
    };
    const policy = {
      async evaluate(request: PolicyRequest) {
        observedPolicyRequests.push(request);
        return { effect: "allow" as const, reason: "integration test policy allow" };
      }
    };
    const audit = {
      async publishDecision(event: unknown) { auditEvents.push(event); return true; },
      async publishFailure(event: unknown) { auditEvents.push(event); }
    };
    const verify = createJwtPrincipalVerifier({ issuer, audience, publicKeyPem });
    const authenticate = createBearerAuthMiddleware(verify);
    const gateway = createAuthenticatedMemoryGateway({ moduleId: "integration-notes", store, policy, audit });
    const response = responseHarness();
    const request = {
      res: response,
      header(name: string) { return name.toLowerCase() === "authorization" ? "Bearer " + signedToken() : undefined; }
    } as unknown as Request;

    let authenticatedNextCalls = 0;
    authenticate(request, response, () => { authenticatedNextCalls += 1; });
    expect(authenticatedNextCalls).toBe(1);

    let gatewayNextCalls = 0;
    gateway(request, response, () => { gatewayNextCalls += 1; });
    expect(gatewayNextCalls).toBe(1);

    const capability = getAuthenticatedMemorySession(response);
    expect(capability).not.toBeNull();
    await capability!.write({ namespace: "private", key: "profile" }, { displayName: "verified" });
    await expect(capability!.read({ namespace: "private", key: "profile" })).resolves.toEqual({ displayName: "verified" });

    expect([...stored.keys()]).toEqual(["integration-tenant/private:profile"]);
    expect(observedPolicyRequests).toHaveLength(2);
    expect(observedPolicyRequests[0]?.actorId).toBe("integration-actor");
    expect(observedPolicyRequests[0]?.context?.attributes).toMatchObject({
      tenantId: "integration-tenant",
      moduleId: "integration-notes"
    });
    expect(auditEvents).toHaveLength(2);
  });

  it("fails closed when the response authentication context is absent", () => {
    const response = responseHarness();
    const request = { res: {} } as Request;
    let nextCalls = 0;
    const gateway = createAuthenticatedMemoryGateway({
      moduleId: "integration-notes",
      store: { async read() { return null; }, async write() {}, async delete() {} },
      policy: { async evaluate() { return { effect: "allow" as const, reason: "test" }; } },
      audit: { async publishDecision() { return true; }, async publishFailure() {} }
    });

    gateway(request, response, () => { nextCalls += 1; });

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({ error: "unauthorized" });
    expect(nextCalls).toBe(0);
  });
});
