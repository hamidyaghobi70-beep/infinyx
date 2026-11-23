import { createPublicKey, verify as verifySignature, type KeyObject } from "node:crypto";
import type { Request, RequestHandler } from "express";
export interface AuthenticatedPrincipal { readonly subject: string; readonly tenantId: string; readonly issuer: string; readonly audience: readonly string[]; readonly expiresAt: number; }
const verifiedPrincipals = new WeakSet<object>();
export interface JwtVerifierOptions { readonly issuer: string; readonly audience: string; readonly publicKeyPem: string; readonly clockToleranceSeconds?: number; readonly now?: () => number; }
export class AuthenticationError extends Error { constructor() { super("Authentication failed."); this.name = "AuthenticationError"; } }
export function createJwtPrincipalVerifier(options: JwtVerifierOptions): (token: string) => AuthenticatedPrincipal {
 if (!options.issuer.trim() || !options.audience.trim() || !(/-----BEGIN PUBLIC KEY-----/.test(options.publicKeyPem) || /-----BEGIN RSA PUBLIC KEY-----/.test(options.publicKeyPem))) throw new TypeError("A trusted issuer, audience and PEM public key are required.");
 const tolerance = options.clockToleranceSeconds ?? 5;
 if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 300) throw new TypeError("Invalid JWT clock tolerance.");
 let key: KeyObject;
 try { key = createPublicKey(options.publicKeyPem); } catch { throw new TypeError("Invalid JWT verification public key."); }
 if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new TypeError("JWT RS256 requires an RSA public key of at least 2048 bits.");
 const now = options.now ?? (() => Date.now() / 1000);
 return (token: string): AuthenticatedPrincipal => {
  try {
   if (typeof token !== "string" || token.length > 16_384) throw new Error();
   const parts = token.split(".");
   if (parts.length !== 3 || parts.some((part) => !part)) throw new Error();
   const header = parseSegment(parts[0]!) as Record<string, unknown>;
   const claims = parseSegment(parts[1]!) as Record<string, unknown>;
   if (header.alg !== "RS256" || (header.typ !== undefined && header.typ !== "JWT") || header.crit !== undefined || (header.b64 !== undefined && header.b64 !== true)) throw new Error();
   if (!verifySignature("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1], "ascii"), key, decodeBase64Url(parts[2]!))) throw new Error();
   const current = now();
   if (!Number.isFinite(current) || claims.iss !== options.issuer || !audienceMatches(claims.aud, options.audience) ||
       !validClaim(claims.sub) || !validClaim(claims.tenant_id) || typeof claims.exp !== "number" || !Number.isFinite(claims.exp) ||
       current >= claims.exp + tolerance ||
       (claims.nbf !== undefined && (typeof claims.nbf !== "number" || !Number.isFinite(claims.nbf) || current + tolerance < claims.nbf))) throw new Error();
   const audiences = typeof claims.aud === "string" ? [claims.aud] : claims.aud as string[];
   const principal = Object.freeze({ subject: claims.sub, tenantId: claims.tenant_id, issuer: options.issuer, audience: Object.freeze([...audiences]), expiresAt: claims.exp });
   verifiedPrincipals.add(principal);
   return principal;
  } catch { throw new AuthenticationError(); }
 };
}
export function isAuthenticatedPrincipal(value: unknown): value is AuthenticatedPrincipal { return !!value && typeof value === "object" && verifiedPrincipals.has(value); }
export function createPrincipalMemoryScope(principal: AuthenticatedPrincipal, moduleId: string) {
 if (!isAuthenticatedPrincipal(principal) || !validClaim(moduleId)) throw new AuthenticationError();
 return Object.freeze({ tenantId: principal.tenantId, actorId: principal.subject, moduleId });
}
export function createBearerAuthMiddleware(verifyToken: (token: string) => AuthenticatedPrincipal): RequestHandler {
 return (request, response, next) => {
  const header = request.header("authorization");
  if (!header || !header.startsWith("Bearer ") || header.length === 7 || Array.from(header.slice(7)).some((character) => character.charCodeAt(0) <= 0x20)) { response.status(401).json({ error: "unauthorized" }); return; }
  try { response.locals.authenticatedPrincipal = verifyToken(header.slice(7)); next(); }
  catch { response.status(401).json({ error: "unauthorized" }); }
 };
}
export function getAuthenticatedPrincipal(request: Request): AuthenticatedPrincipal | null {
 const principal = (request.res?.locals as { authenticatedPrincipal?: unknown } | undefined)?.authenticatedPrincipal;
 return isAuthenticatedPrincipal(principal) ? principal : null;
}
function decodeBase64Url(segment: string): Buffer { if (!/^[A-Za-z0-9_-]+$/.test(segment) || segment.length % 4 === 1) throw new Error(); const decoded = Buffer.from(segment, "base64url"); if (decoded.toString("base64url") !== segment) throw new Error(); return decoded; }
function parseSegment(segment: string): unknown { const parsed: unknown = JSON.parse(decodeBase64Url(segment).toString("utf8")); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(); return parsed; }
function audienceMatches(value: unknown, expected: string): boolean { return value === expected || (Array.isArray(value) && value.includes(expected) && value.every((item) => typeof item === "string")); }
function validClaim(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= 256 && !Array.from(value).some((character) => { const code = character.charCodeAt(0); return code <= 0x1f || (code >= 0x7f && code <= 0x9f); }); }

export interface JwtPublicKeyResolver { resolve(kid: string): Promise<KeyObject>; }
export interface JwksJwtVerifierOptions { readonly issuer: string; readonly audience: string; readonly clockToleranceSeconds?: number; readonly now?: () => number; }

/** Async RS256 verifier backed by an operator-configured trusted JWKS resolver. */
export function createJwksJwtPrincipalVerifier(options: JwksJwtVerifierOptions, resolver: JwtPublicKeyResolver): (token: string) => Promise<AuthenticatedPrincipal> {
 if (!options.issuer.trim() || !options.audience.trim()) throw new TypeError("A trusted issuer and audience are required.");
 const tolerance = options.clockToleranceSeconds ?? 5;
 if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 300) throw new TypeError("Invalid JWT clock tolerance.");
 const now = options.now ?? (() => Date.now() / 1000);
 return async (token: string): Promise<AuthenticatedPrincipal> => {
  try {
   if (typeof token !== "string" || token.length > 16_384) throw new Error();
   const parts = token.split(".");
   if (parts.length !== 3 || parts.some((part) => !part)) throw new Error();
   const header = parseSegment(parts[0]!) as Record<string, unknown>;
   const claims = parseSegment(parts[1]!) as Record<string, unknown>;
   if (header.alg !== "RS256" || (header.typ !== undefined && header.typ !== "JWT") || header.crit !== undefined || (header.b64 !== undefined && header.b64 !== true) || !validClaim(header.kid)) throw new Error();
   const key = await resolver.resolve(header.kid);
   if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error();
   if (!verifySignature("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1], "ascii"), key, decodeBase64Url(parts[2]!))) throw new Error();
   const current = now();
   if (!Number.isFinite(current) || claims.iss !== options.issuer || !audienceMatches(claims.aud, options.audience) ||
       !validClaim(claims.sub) || !validClaim(claims.tenant_id) || typeof claims.exp !== "number" || !Number.isFinite(claims.exp) ||
       current >= claims.exp + tolerance ||
       (claims.nbf !== undefined && (typeof claims.nbf !== "number" || !Number.isFinite(claims.nbf) || current + tolerance < claims.nbf))) throw new Error();
   const audiences = typeof claims.aud === "string" ? [claims.aud] : claims.aud as string[];
   const principal = Object.freeze({ subject: claims.sub, tenantId: claims.tenant_id, issuer: options.issuer, audience: Object.freeze([...audiences]), expiresAt: claims.exp });
   verifiedPrincipals.add(principal);
   return principal;
  } catch { throw new AuthenticationError(); }
 };
}

export function createAsyncBearerAuthMiddleware(verifyToken: (token: string) => Promise<AuthenticatedPrincipal>): RequestHandler {
 return (request, response, next) => {
  const header = request.header("authorization");
  if (!header || !header.startsWith("Bearer ") || header.length === 7 || Array.from(header.slice(7)).some((character) => character.charCodeAt(0) <= 0x20)) { response.status(401).json({ error: "unauthorized" }); return; }
  void verifyToken(header.slice(7)).then((principal) => { response.locals.authenticatedPrincipal = principal; next(); }).catch(() => { response.status(401).json({ error: "unauthorized" }); });
 };
}
