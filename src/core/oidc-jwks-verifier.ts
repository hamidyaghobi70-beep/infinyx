import { createPublicKey, verify as verifySignature, type KeyObject } from "node:crypto";
import { AuthenticationError } from "./authentication-error.js";

export interface VerifiedExternalIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly audience: readonly string[];
  readonly expiresAt: number;
}

const verifiedExternalIdentities = new WeakSet<object>();

export function isVerifiedExternalIdentity(value: unknown): value is VerifiedExternalIdentity {
  return !!value && typeof value === "object" && verifiedExternalIdentities.has(value);
}

export interface OidcJwksVerifierOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly authorizedParties: readonly string[];
  readonly clockToleranceSeconds?: number;
  readonly cacheTtlMs?: number;
  readonly requestTimeoutMs?: number;
  readonly now?: () => number;
  readonly fetcher?: typeof fetch;
}

interface DiscoveryDocument {
  readonly issuer: string;
  readonly jwks_uri: string;
}

interface CachedKeys {
  readonly expiresAt: number;
  readonly refreshedAt: number;
  readonly keys: ReadonlyMap<string, KeyObject>;
}

const MAX_TOKEN_LENGTH = 16_384;
const MAX_DOCUMENT_LENGTH = 262_144;
const KID_PATTERN = /^[A-Za-z0-9._~-]{1,256}$/u;

export function createOidcJwksPrincipalVerifier(
  options: OidcJwksVerifierOptions
): (token: string) => Promise<VerifiedExternalIdentity> {
  const issuer = validateHttpsUrl(options.issuer);
  if (!options.audience.trim() || !Array.isArray(options.authorizedParties) ||
      options.authorizedParties.length === 0 ||
      options.authorizedParties.some((party) => typeof party !== "string" || !party.trim())) {
    throw new TypeError("A trusted API audience and at least one authorized client are required.");
  }

  const tolerance = options.clockToleranceSeconds ?? 5;
  const cacheTtlMs = options.cacheTtlMs ?? 300_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 3_000;
  if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 60 ||
      !Number.isInteger(cacheTtlMs) || cacheTtlMs < 1_000 || cacheTtlMs > 3_600_000 ||
      !Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 100 || requestTimeoutMs > 10_000) {
    throw new TypeError("Invalid OIDC verifier limits.");
  }

  const allowedParties = new Set(options.authorizedParties);
  const now = options.now ?? (() => Date.now() / 1000);
  const fetcher = options.fetcher ?? fetch;
  let cache: CachedKeys | undefined;
  let refreshPromise: Promise<CachedKeys> | undefined;
  let lastForcedRefreshAt = 0;

  const fetchJson = async (url: string): Promise<Record<string, unknown>> => {
    const response = await fetcher(url, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(requestTimeoutMs)
    });
    if (!response.ok) throw new Error("OIDC endpoint unavailable.");
    const body = await response.text();
    if (body.length > MAX_DOCUMENT_LENGTH) throw new Error("OIDC document too large.");
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalid OIDC document.");
    }
    return parsed as Record<string, unknown>;
  };

  const refreshKeys = async (): Promise<CachedKeys> => {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      const discoveryUrl = `${issuer.replace(/\/$/u, "")}/.well-known/openid-configuration`;
      const discovery = await fetchJson(discoveryUrl);
      if (discovery.issuer !== issuer) throw new Error("OIDC issuer mismatch.");
      if (typeof discovery.jwks_uri !== "string") throw new Error("Missing JWKS URI.");
      const jwksUrl = validateHttpsUrl(discovery.jwks_uri);
      const jwks = await fetchJson(jwksUrl);
      if (!Array.isArray(jwks.keys) || jwks.keys.length === 0 || jwks.keys.length > 100) {
        throw new Error("Invalid JWKS.");
      }

      const keys = new Map<string, KeyObject>();
      for (const candidate of jwks.keys) {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
        const jwk = candidate as Record<string, unknown>;
        if (jwk.kty !== "RSA" || (jwk.use !== undefined && jwk.use !== "sig") ||
            (jwk.alg !== undefined && jwk.alg !== "RS256") ||
            typeof jwk.kid !== "string" || !KID_PATTERN.test(jwk.kid)) continue;
        try {
          const key = createPublicKey({ key: jwk as JsonWebKey, format: "jwk" });
          if (key.asymmetricKeyType !== "rsa" ||
              (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) continue;
          keys.set(jwk.kid, key);
        } catch {
          // Ignore unusable public keys; a token can only select a validated kid.
        }
      }
      if (keys.size === 0) throw new Error("No usable signing keys.");
      const refreshedAt = Date.now();
      const result = Object.freeze({
        expiresAt: refreshedAt + cacheTtlMs,
        refreshedAt,
        keys
      });
      cache = result;
      return result;
    })().finally(() => { refreshPromise = undefined; });
    return refreshPromise;
  };

  const getKey = async (kid: string): Promise<KeyObject> => {
    let current = cache;
    if (!current || current.expiresAt <= Date.now()) current = await refreshKeys();
    let key = current.keys.get(kid);
    if (!key) {
      const nowMs = Date.now();
      if (nowMs - lastForcedRefreshAt >= 10_000) {
        lastForcedRefreshAt = nowMs;
        current = await refreshKeys();
        key = current.keys.get(kid);
      }
    }
    if (!key) throw new Error("Unknown signing key.");
    return key;
  };

  return async (token: string): Promise<VerifiedExternalIdentity> => {
    try {
      if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
        throw new Error();
      }
      const parts = token.split(".");
      if (parts.length !== 3 || parts.some((part) => !part)) throw new Error();
      const header = parseSegment(parts[0]!) as Record<string, unknown>;
      const claims = parseSegment(parts[1]!) as Record<string, unknown>;

      if (header.alg !== "RS256" || header.typ !== "JWT" ||
          typeof header.kid !== "string" || !KID_PATTERN.test(header.kid) ||
          header.jku !== undefined || header.x5u !== undefined || header.jwk !== undefined ||
          header.crit !== undefined || claims.typ !== "Bearer" ||
          typeof claims.azp !== "string" || !allowedParties.has(claims.azp)) {
        throw new Error();
      }

      const key = await getKey(header.kid);
      if (!verifySignature(
        "RSA-SHA256",
        Buffer.from(parts[0] + "." + parts[1], "ascii"),
        key,
        Buffer.from(parts[2]!, "base64url")
      )) throw new Error();

      const current = now();
      const audiences = normalizeAudience(claims.aud);
      if (!Number.isFinite(current) || claims.iss !== issuer ||
          !audiences.includes(options.audience) ||
          !validSubject(claims.sub) ||
          typeof claims.exp !== "number" || !Number.isFinite(claims.exp) ||
          typeof claims.iat !== "number" || !Number.isFinite(claims.iat) ||
          current >= claims.exp + tolerance ||
          current + tolerance < claims.iat ||
          claims.iat >= claims.exp ||
          (claims.nbf !== undefined &&
            (typeof claims.nbf !== "number" || !Number.isFinite(claims.nbf) ||
             current + tolerance < claims.nbf))) {
        throw new Error();
      }

      const identity = Object.freeze({
        issuer,
        subject: claims.sub,
        audience: Object.freeze(audiences),
        expiresAt: claims.exp
      });
      verifiedExternalIdentities.add(identity);
      return identity;
    } catch {
      throw new AuthenticationError();
    }
  };
}

function validateHttpsUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("Invalid trusted OIDC URL.");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password ||
      parsed.hash || parsed.search || value.trim() !== value) {
    throw new TypeError("OIDC endpoints must be HTTPS URLs without credentials, query, or fragment.");
  }
  return value;
}

function parseSegment(segment: string): unknown {
  const parsed: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
  return parsed;
}

function normalizeAudience(value: unknown): string[] {
  if (typeof value === "string" && value.length > 0) return [value];
  if (Array.isArray(value) && value.length > 0 &&
      value.every((item) => typeof item === "string" && item.length > 0)) {
    return value as string[];
  }
  throw new Error();
}

function validSubject(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 &&
    value.length <= 512 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}
