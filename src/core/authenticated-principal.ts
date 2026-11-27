import type { Request, RequestHandler } from "express";
import { AuthenticationError } from "./authentication-error.js";
import { isVerifiedExternalIdentity, type VerifiedExternalIdentity } from "./oidc-jwks-verifier.js";

export { AuthenticationError } from "./authentication-error.js";
export { createOidcJwksPrincipalVerifier } from "./oidc-jwks-verifier.js";
export type { OidcJwksVerifierOptions } from "./oidc-jwks-verifier.js";
export { isVerifiedExternalIdentity } from "./oidc-jwks-verifier.js";
export type { VerifiedExternalIdentity } from "./oidc-jwks-verifier.js";

export interface AuthenticatedPrincipal {
  readonly userId: string;
  readonly issuer: string;
  readonly subject: string;
  readonly audience: readonly string[];
  readonly expiresAt: number;
}

const authenticatedPrincipals = new WeakSet<object>();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

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

export type ExternalIdentityVerifier =
  (token: string) => VerifiedExternalIdentity | Promise<VerifiedExternalIdentity>;

export type AuthenticatedPrincipalResolver =
  (identity: VerifiedExternalIdentity) => AuthenticatedPrincipal | Promise<AuthenticatedPrincipal>;

export function createBearerAuthMiddleware(
  verifyToken: ExternalIdentityVerifier,
  resolvePrincipal: AuthenticatedPrincipalResolver
): RequestHandler {
  return (request, response, next) => {
    const header = request.header("authorization");
    const reject = () => { response.status(401).json({ error: "unauthorized" }); };
    if (!header || !/^Bearer [^\s]+$/.test(header)) {
      reject();
      return;
    }
    void (async () => {
      try {
        const identity = await verifyToken(header.slice(7));
        const principal = await resolvePrincipal(identity);
        if (!isAuthenticatedPrincipal(principal)) {
          reject();
          return;
        }
        response.locals.authenticatedPrincipal = principal;
        next();
      } catch {
        reject();
      }
    })();
  };
}

export function getAuthenticatedPrincipal(request: Request): AuthenticatedPrincipal | null {
  const principal = (request.res?.locals as
    { authenticatedPrincipal?: unknown } | undefined)?.authenticatedPrincipal;
  return isAuthenticatedPrincipal(principal) ? principal : null;
}

function validModuleId(value: unknown): value is string {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 128 &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}
