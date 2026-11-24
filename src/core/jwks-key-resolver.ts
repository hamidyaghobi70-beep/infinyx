import { createPublicKey, type KeyObject } from "node:crypto";

export interface JwksKeyResolverOptions {
  readonly jwksUrl: string;
  readonly fetcher?: typeof fetch;
  readonly cacheTtlMs?: number;
  readonly refreshCooldownMs?: number;
  readonly now?: () => number;
}

interface CachedKey { readonly key: KeyObject; readonly expiresAt: number; }
interface Jwk { readonly kty?: unknown; readonly use?: unknown; readonly alg?: unknown; readonly kid?: unknown; readonly n?: unknown; readonly e?: unknown; }

const MAX_JWKS_BYTES = 256 * 1024;
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;

/**
 * Resolves RS256 signing keys from a trusted OIDC JWKS endpoint.
 * The endpoint must be configured by the operator; redirects are never followed.
 */
export class JwksKeyResolver {
  readonly #url: URL;
  readonly #fetcher: typeof fetch;
  readonly #ttl: number;
  readonly #refreshCooldownMs: number;
  readonly #now: () => number;
  #lastRefreshAt = Number.NEGATIVE_INFINITY;
  #cache = new Map<string, CachedKey>();
  #refreshInFlight: Promise<void> | undefined;

  constructor(options: JwksKeyResolverOptions) {
    let jwksUrl: unknown, fetcher: unknown, ttlValue: unknown, cooldownValue: unknown, nowValue: unknown;
    try {
      jwksUrl = options.jwksUrl;
      fetcher = options.fetcher;
      ttlValue = options.cacheTtlMs;
      cooldownValue = options.refreshCooldownMs;
      nowValue = options.now;
    } catch {
      throw new TypeError("JWKS resolver options must be readable.");
    }
    let url: URL;
    try { url = new URL(jwksUrl as string); } catch { throw new TypeError("Invalid JWKS URL."); }
    if (url.protocol !== "https:" || url.username || url.password || url.hash) {
      throw new TypeError("JWKS URL must be an HTTPS URL without credentials or fragment.");
    }
    const ttl = ttlValue === undefined ? DEFAULT_CACHE_TTL_MS : ttlValue as number;
    if (!Number.isInteger(ttl) || ttl < 1_000 || ttl > 15 * 60_000) throw new TypeError("Invalid JWKS cache TTL.");
    const refreshCooldownMs = cooldownValue === undefined ? 1_000 : cooldownValue as number;
    if (!Number.isInteger(refreshCooldownMs) || refreshCooldownMs < 0 || refreshCooldownMs > 60_000) throw new TypeError("Invalid JWKS refresh cooldown.");
    const selectedFetcher = fetcher === undefined ? fetch : fetcher;
    if (typeof selectedFetcher !== "function") throw new TypeError("JWKS fetcher must be a function.");
    if (nowValue !== undefined && typeof nowValue !== "function") throw new TypeError("JWKS clock must be a function.");
    this.#url = url;
    this.#fetcher = selectedFetcher as typeof fetch;
    this.#ttl = ttl;
    this.#refreshCooldownMs = refreshCooldownMs;
    this.#now = nowValue === undefined ? Date.now : (nowValue as () => number).bind(options);
    Object.freeze(this);
  }

  async resolve(kid: string): Promise<KeyObject> {
    if (!kid || kid.length > 256) throw new TypeError("A valid JWT key id is required.");
    const cached = this.#cache.get(kid);
    if (cached && cached.expiresAt > this.#now()) return cached.key;
    await this.refresh(cached !== undefined && cached.expiresAt <= this.#now());
    const refreshed = this.#cache.get(kid);
    if (!refreshed || refreshed.expiresAt <= this.#now()) throw new Error("No trusted RS256 signing key matches this key id.");
    return refreshed.key;
  }

  private async refresh(force: boolean): Promise<void> {
    if (!force && this.#now() - this.#lastRefreshAt < this.#refreshCooldownMs) return;
    if (!this.#refreshInFlight) {
      this.#lastRefreshAt = this.#now();
      this.#refreshInFlight = this.load().finally(() => { this.#refreshInFlight = undefined; });
    }
    await this.#refreshInFlight;
  }

  private async load(): Promise<void> {
    const response = await this.#fetcher(this.#url, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(5_000)
    });
    if (!response.ok) throw new Error("JWKS endpoint returned an unsuccessful response.");
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > MAX_JWKS_BYTES) throw new Error("JWKS response exceeds the size limit.");
    if (!response.body) throw new Error("JWKS response body is missing.");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_JWKS_BYTES) {
          await reader.cancel();
          throw new Error("JWKS response exceeds the size limit.");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), totalBytes);
    const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { keys?: unknown }).keys)) {
      throw new Error("Malformed JWKS document.");
    }
    const next = new Map<string, CachedKey>();
    for (const candidate of (parsed as { keys: Jwk[] }).keys) {
      if (!candidate || candidate.kty !== "RSA" || candidate.use !== "sig" || candidate.alg !== "RS256" ||
          typeof candidate.kid !== "string" || !candidate.kid || candidate.kid.length > 256 ||
          typeof candidate.n !== "string" || typeof candidate.e !== "string") continue;
      if (next.has(candidate.kid)) throw new Error("JWKS contains a duplicate key id.");
      try {
        const key = createPublicKey({ key: { kty: "RSA", n: candidate.n, e: candidate.e }, format: "jwk" });
        if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) continue;
        next.set(candidate.kid, { key, expiresAt: this.#now() + this.#ttl });
      } catch { /* Ignore malformed or unsuitable keys; never weaken verification. */ }
    }
    if (next.size === 0) throw new Error("JWKS contains no acceptable RS256 signing keys.");
    this.#cache = next;
  }
}
