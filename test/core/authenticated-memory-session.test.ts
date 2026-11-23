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
function verifiedPrincipal() {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = encode({ alg: "RS256", typ: "JWT" }) + "." + encode(claims);
  const token = input + "." + sign("RSA-SHA256", Buffer.from(input), pair.privateKey).toString("base64url");
  return createJwtPrincipalVerifier({ issuer, audience, publicKeyPem: pem, now: () => 1_800_000_000 })(token);
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
