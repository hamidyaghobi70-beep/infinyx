import { createPublicKey, verify as verifySignature, type KeyObject } from "node:crypto";
import type { Request, RequestHandler } from "express";

export interface VerifiedExternalIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly audience: readonly string[];
  readonly expiresAt: number;
}

export interface AuthenticatedPrincipal {
  readonly userId: string;
  readonly issuer: string;
  readonly subject: string;
  readonly audience: readonly string[];
  readonly expiresAt: number;
}

const verifiedExternalIdentities = new WeakSet<object>();
const authenticatedPrincipals = new WeakSet<object>();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface JwtVerifierOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly publicKeyPem: string;
  readonly clockToleranceSeconds?: number;
  readonly now?: () => number;
}

export class AuthenticationError extends Error {
  constructor() {
    super("Authentication failed.");
    this.name = "AuthenticationError";
  }
}

/**
 * Verifies provider-signed identity provenance only. Tenant and role claims are
 * intentionally ignored; they are never authorization evidence in INFINYX.
 */
export function createJwtPrincipalVerifier(
  options: JwtVerifierOptions
): (token: string) => VerifiedExternalIdentity {
  if (!options.issuer.trim() || !options.audience.trim() ||
      !options.publicKeyPem.includes("BEGIN PUBLIC KEY")) {
    throw new TypeError("A trusted issuer, audience and PEM public key are required.");
  }

  const tolerance = options.clockToleranceSeconds ?? 5;
  if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 300) {
    throw new TypeError("Invalid JWT clock tolerance.");
  }

  let key: KeyObject;
  try {
    key = createPublicKey(options.publicKeyPem);
  } catch {
    throw new TypeError("Invalid JWT verification public key.");
  }

  const now = options.now ?? (() => Date.now() / 1000);
  return (token: string): VerifiedExternalIdentity => {
    try {
      if (typeof token !== "string" || token.length > 16_384) throw new Error();
      const parts = token.split(".");
      if (parts.length !== 3 || parts.some((part) => !part)) throw new Error();

      const header = parseSegment(parts[0]!) as Record<string, unknown>;
      const claims = parseSegment(parts[1]!) as Record<string, unknown>;
      if (header.alg !== "RS256" || (header.typ !== undefined && header.typ !== "JWT")) {
        throw new Error();
      }
      if (!verifySignature(
        "RSA-SHA256",
        Buffer.from(parts[0] + "." + parts[1], "ascii"),
        key,
        Buffer.from(parts[2]!, "base64url")
      )) throw new Error();

      const current = now();
      if (!Number.isFinite(current) ||
          claims.iss !== options.issuer ||
          !audienceMatches(claims.aud, options.audience) ||
          !validSubject(claims.sub) ||
          typeof claims.exp !== "number" ||
          !Number.isFinite(claims.exp) ||
          current >= claims.exp + tolerance ||
          (claims.nbf !== undefined &&
            (typeof claims.nbf !== "number" ||
             !Number.isFinite(claims.nbf) ||
             current + tolerance < claims.nbf))) {
        throw new Error();
      }

      const audiences = typeof claims.aud === "string"
        ? [claims.aud]
        : claims.aud as string[];
      const identity = Object.freeze({
        issuer: options.issuer,
        subject: claims.sub,
        audience: Object.freeze([...audiences]),
        expiresAt: claims.exp
      });
      verifiedExternalIdentities.add(identity);
      return identity;
    } catch {
      throw new AuthenticationError();
    }
  };
}

export function isVerifiedExternalIdentity(value: unknown): value is VerifiedExternalIdentity {
  return !!value && typeof value === "object" && verifiedExternalIdentities.has(value);
}

/**
 * Resolves a verified provider identity through the INFINYX-owned identity
 * directory. Unknown identities fail closed; no email/phone matching occurs.
 */
export function createAuthenticatedPrincipalResolver(
  resolveInternalUserId: (issuer: string, subject: string) => string | null
): (identity: VerifiedExternalIdentity) => AuthenticatedPrincipal;
export function createAuthenticatedPrincipalResolver(
  resolveInternalUserId: (issuer: string, subject: string) => Promise<string | null>
): (identity: VerifiedExternalIdentity) => Promise<AuthenticatedPrincipal>;
export function createAuthenticatedPrincipalResolver(
  resolveInternalUserId: (issuer: string, subject: string) => string | null | Promise<string | null>
): (identity: VerifiedExternalIdentity) => AuthenticatedPrincipal | Promise<AuthenticatedPrincipal> {
  const create = (identity: VerifiedExternalIdentity, userId: string | null): AuthenticatedPrincipal => {
    if (!isVerifiedExternalIdentity(identity) ||
        typeof userId !== "string" || !UUID_PATTERN.test(userId)) {
      throw new AuthenticationError();
    }
    const principal = Object.freeze({
      userId,
      issuer: identity.issuer,
      subject: identity.subject,
      audience: Object.freeze([...identity.audience]),
      expiresAt: identity.expiresAt
    });
    authenticatedPrincipals.add(principal);
    return principal;
  };
  return (identity) => {
    if (!isVerifiedExternalIdentity(identity)) throw new AuthenticationError();
    try {
      const resolved = resolveInternalUserId(identity.issuer, identity.subject);
      if (resolved instanceof Promise) {
        return resolved.then((userId) => create(identity, userId)).catch(() => {
          throw new AuthenticationError();
        });
      }
      return create(identity, resolved);
    } catch {
      throw new AuthenticationError();
    }
  };
}

export function isAuthenticatedPrincipal(value: unknown): value is AuthenticatedPrincipal {
  return !!value && typeof value === "object" && authenticatedPrincipals.has(value);
}

/** Personal memory is keyed only by the stable internal user ID. */
export function createPrincipalMemoryScope(
  principal: AuthenticatedPrincipal,
  moduleId: string
) {
  if (!isAuthenticatedPrincipal(principal) || !validModuleId(moduleId)) {
    throw new AuthenticationError();
  }
  return Object.freeze({ scope: "personal" as const, userId: principal.userId, moduleId });
}

export type AuthenticatedPrincipalResolver =
  (identity: VerifiedExternalIdentity) => AuthenticatedPrincipal | Promise<AuthenticatedPrincipal>;

export function createBearerAuthMiddleware(
  verifyToken: (token: string) => VerifiedExternalIdentity,
  resolvePrincipal: AuthenticatedPrincipalResolver
): RequestHandler {
  return (request, response, next) => {
    const header = request.header("authorization");
    const reject = () => { response.status(401).json({ error: "unauthorized" }); };
    if (!header || !/^Bearer [^\s]+$/.test(header)) {
      reject();
      return;
    }
    const accept = (principal: AuthenticatedPrincipal) => {
      if (!isAuthenticatedPrincipal(principal)) {
        reject();
        return;
      }
      response.locals.authenticatedPrincipal = principal;
      next();
    };
    try {
      const identity = verifyToken(header.slice(7));
      const resolved = resolvePrincipal(identity);
      if (resolved instanceof Promise) {
        void resolved.then(accept).catch(reject);
      } else {
        accept(resolved);
      }
    } catch {
      reject();
    }
  };
}

export function getAuthenticatedPrincipal(request: Request): AuthenticatedPrincipal | null {
  const principal = (request.res?.locals as
    { authenticatedPrincipal?: unknown } | undefined)?.authenticatedPrincipal;
  return isAuthenticatedPrincipal(principal) ? principal : null;
}

function parseSegment(segment: string): unknown {
  const parsed: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
  return parsed;
}

function audienceMatches(value: unknown, expected: string): boolean {
  return value === expected ||
    (Array.isArray(value) && value.includes(expected) &&
     value.every((item) => typeof item === "string"));
}

function validSubject(value: unknown): value is string {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 512 &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function validModuleId(value: unknown): value is string {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 128 &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}
