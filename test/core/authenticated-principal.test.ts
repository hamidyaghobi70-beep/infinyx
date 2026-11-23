import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { createJwtPrincipalVerifier, createPrincipalMemoryScope, AuthenticationError } from "../../src/core/authenticated-principal.js";
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
const options = { issuer: "https://identity.example.test/", audience: "infinyx-api", publicKeyPem: pem, now: () => 1_800_000_000 };
function token(claims: Record<string, unknown>, alg = "RS256") { const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url"); const input = encode({ alg, typ: "JWT" }) + "." + encode(claims); return input + "." + sign("RSA-SHA256", Buffer.from(input), pair.privateKey).toString("base64url"); }
const claims = { iss: options.issuer, aud: options.audience, sub: "user-42", tenant_id: "tenant-7", exp: 1_800_000_060 };
describe("verified JWT principal", () => {
 it("accepts signed RS256 tokens and derives a tenant-scoped memory identity", () => { const principal = createJwtPrincipalVerifier(options)(token(claims)); expect(createPrincipalMemoryScope(principal, "notes")).toEqual({ tenantId: "tenant-7", actorId: "user-42", moduleId: "notes" }); });
 it("rejects expired, wrong issuer, wrong audience, missing tenant and wrong algorithm", () => { const verify = createJwtPrincipalVerifier(options); for (const bad of [token({ ...claims, exp: 1_799_999_990 }), token({ ...claims, iss: "https://evil.test" }), token({ ...claims, aud: "other" }), token({ iss: claims.iss, aud: claims.aud, sub: claims.sub, exp: claims.exp }), token(claims, "none")]) expect(() => verify(bad)).toThrow(AuthenticationError); });
 it("rejects fabricated principal objects", () => { expect(() => createPrincipalMemoryScope({ subject: "fake", tenantId: "t" } as never, "notes")).toThrow(AuthenticationError); });
});
