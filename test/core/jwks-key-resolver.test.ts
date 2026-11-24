import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { JwksKeyResolver } from "../../src/core/jwks-key-resolver.js";

const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = pair.publicKey.export({ format: "jwk" });
const response = (keys: unknown[], status = 200) => new Response(JSON.stringify({ keys }), { status, headers: { "content-type": "application/json" } });

describe("JWKS key resolver", () => {
  it("loads and caches a trusted RS256 RSA key", async () => {
    const fetcher = vi.fn(async () => response([{ ...jwk, kid: "key-1", use: "sig", alg: "RS256" }]));
    const resolver = new JwksKeyResolver({ jwksUrl: "https://id.example.test/realms/main/protocol/openid-connect/certs", fetcher });
    const first = await resolver.resolve("key-1");
    const second = await resolver.resolve("key-1");
    expect(first.asymmetricKeyType).toBe("rsa");
    expect(second).toBe(first);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("refreshes once when a rotated key id is requested", async () => {
    const secondPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const secondJwk = secondPair.publicKey.export({ format: "jwk" });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response([{ ...jwk, kid: "old", use: "sig", alg: "RS256" }]))
      .mockResolvedValueOnce(response([{ ...secondJwk, kid: "new", use: "sig", alg: "RS256" }]));
    const resolver = new JwksKeyResolver({ jwksUrl: "https://id.example.test/jwks", fetcher, refreshCooldownMs: 0 });
    await resolver.resolve("old");
    expect((await resolver.resolve("new")).asymmetricKeyType).toBe("rsa");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects unknown keys and unsuitable JWKS entries", async () => {
    const resolver = new JwksKeyResolver({
      jwksUrl: "https://id.example.test/jwks",
      fetcher: async () => response([{ ...jwk, kid: "wrong-alg", use: "sig", alg: "RS512" }])
    });
    await expect(resolver.resolve("missing")).rejects.toThrow();
  });

  it("rejects insecure or credential-bearing endpoints", () => {
    expect(() => new JwksKeyResolver({ jwksUrl: "http://id.example.test/jwks" })).toThrow(TypeError);
    expect(() => new JwksKeyResolver({ jwksUrl: "https://user:pass@id.example.test/jwks" })).toThrow(TypeError);
  });


  it("rejects duplicate key identifiers instead of selecting an ambiguous key", async () => {
    const duplicate = { ...jwk, kid: "duplicate", use: "sig", alg: "RS256" };
    const resolver = new JwksKeyResolver({
      jwksUrl: "https://id.example.test/jwks",
      fetcher: async () => response([duplicate, duplicate])
    });
    await expect(resolver.resolve("duplicate")).rejects.toThrow(/duplicate key id/i);
  });

  it("enforces the response byte limit while streaming", async () => {
    const oversized = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(256 * 1024 + 1));
        controller.close();
      }
    }), { status: 200 });
    const resolver = new JwksKeyResolver({
      jwksUrl: "https://id.example.test/jwks",
      fetcher: async () => oversized
    });
    await expect(resolver.resolve("key")).rejects.toThrow(/size limit/i);
  });

  it("rejects oversized cache TTL and failed endpoint responses", async () => {
    expect(() => new JwksKeyResolver({ jwksUrl: "https://id.example.test/jwks", cacheTtlMs: 99_000_000 })).toThrow(TypeError);
    const resolver = new JwksKeyResolver({ jwksUrl: "https://id.example.test/jwks", fetcher: async () => response([], 503) });
    await expect(resolver.resolve("key")).rejects.toThrow();
  });
});
