import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { createJwtPrincipalVerifier } from "../../src/core/authenticated-principal.js";
import { createAuthenticatedMemorySession } from "../../src/core/authenticated-memory-session.js";
import { GuardedMemoryPort } from "../../src/core/guarded-memory-port.js";

const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
const issuer = "https://identity.example.test/";
const audience = "infinyx-api";
const claims = { iss: issuer, aud: audience, sub: "actor-9", tenant_id: "tenant-3", exp: 1_900_000_000 };
function verifiedPrincipal(expiresAt = claims.exp, verificationTime = 1_800_000_000) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = encode({ alg: "RS256", typ: "JWT" }) + "." + encode({ ...claims, exp: expiresAt });
  const token = input + "." + sign("RSA-SHA256", Buffer.from(input), pair.privateKey).toString("base64url");
  return createJwtPrincipalVerifier({ issuer, audience, publicKeyPem: pem, now: () => verificationTime })(token);
}
function dependencies() {
  return {
    store: { read: vi.fn(async () => null), write: vi.fn(async () => undefined), delete: vi.fn(async () => undefined) },
    policy: { evaluate: vi.fn(async () => ({ effect: "deny" as const, reason: "test" })) },
    audit: { publishDecision: vi.fn(async () => true), publishFailure: vi.fn(async () => undefined) }
  };
}

describe("authenticated request-scoped memory session", () => {
  it("derives tenant and actor scope only from a verifier-issued principal", () => {
    const deps = dependencies();
    const session = createAuthenticatedMemorySession({ ...deps, principal: verifiedPrincipal(), moduleId: "notes" });
    expect(session).toBeInstanceOf(GuardedMemoryPort);
    expect(session.scopeModuleId).toBe("notes");
  });

  it("rejects a principal whose token expired after verification but before session creation", () => {
    const deps = dependencies();
    const expiredAt = Math.floor(Date.now() / 1000) - 10;
    const principal = verifiedPrincipal(expiredAt, expiredAt - 1);
    expect(() => createAuthenticatedMemorySession({ ...deps, principal, moduleId: "notes" }))
      .toThrow(/unexpired authenticated principal/i);
  });

  it("rejects fabricated principals and invalid module identities", () => {
    const deps = dependencies();
    expect(() => createAuthenticatedMemorySession({
      ...deps,
      principal: { subject: "fake", tenantId: "tenant-evil", issuer, audience: [audience], expiresAt: 1_900_000_000 } as never,
      moduleId: "notes"
    })).toThrow(/authenticated principal/i);
    expect(() => createAuthenticatedMemorySession({ ...deps, principal: verifiedPrincipal(), moduleId: "" })).toThrow();
  });

  it("does not allow the caller to supply an independent tenant or actor scope", () => {
    const deps = dependencies();
    const session = createAuthenticatedMemorySession({ ...deps, principal: verifiedPrincipal(), moduleId: "notes" });
    return expect(session.write({ namespace: "private", key: "profile" }, { value: "x" })).rejects.toThrow();
  });
});
