export const SESSION_COOKIE_NAME = "__Host-infinyx_session";
const MAX_COOKIE_HEADER_BYTES = 8192;

export function createSessionCookie(
  sessionId: string,
  options: { readonly secure: boolean; readonly maxAgeSeconds?: number }
): string {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(sessionId) || !options.secure) {
    throw new TypeError("Secure session cookie configuration is required.");
  }
  const maxAge = options.maxAgeSeconds;
  if (maxAge !== undefined && (!Number.isSafeInteger(maxAge) || maxAge < 1 || maxAge > 31_536_000)) {
    throw new TypeError("Invalid session cookie lifetime.");
  }
  return [
    `${SESSION_COOKIE_NAME}=${sessionId}`,
    "Path=/",
    "Secure",
    "HttpOnly",
    "SameSite=Lax",
    ...(maxAge === undefined ? [] : [`Max-Age=${maxAge}`])
  ].join("; ");
}

export function createExpiredSessionCookie(): string {
  return [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "Secure",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0"
  ].join("; ");
}

export function readSessionCookie(header: string | undefined): string | null {
  if (typeof header !== "string" || Buffer.byteLength(header, "utf8") > MAX_COOKIE_HEADER_BYTES) {
    return null;
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== SESSION_COOKIE_NAME) continue;
    const value = part.slice(separator + 1).trim();
    return /^[A-Za-z0-9_-]{43}$/u.test(value) ? value : null;
  }
  return null;
}

export const LOGIN_TRANSACTION_COOKIE_NAME = "__Host-infinyx_oidc_tx";

export function createLoginTransactionCookie(binding: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(binding)) {
    throw new TypeError("Invalid login transaction binding.");
  }
  return [
    `${LOGIN_TRANSACTION_COOKIE_NAME}=${binding}`,
    "Path=/",
    "Secure",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=600"
  ].join("; ");
}

export function createExpiredLoginTransactionCookie(): string {
  return [
    `${LOGIN_TRANSACTION_COOKIE_NAME}=`,
    "Path=/",
    "Secure",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0"
  ].join("; ");
}

export function readLoginTransactionCookie(header: string | undefined): string | null {
  if (typeof header !== "string" || Buffer.byteLength(header, "utf8") > MAX_COOKIE_HEADER_BYTES) {
    return null;
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== LOGIN_TRANSACTION_COOKIE_NAME) continue;
    const value = part.slice(separator + 1).trim();
    return /^[A-Za-z0-9_-]{43}$/u.test(value) ? value : null;
  }
  return null;
}


export const IDENTITY_SECURITY_TRANSACTION_COOKIE_NAME = "__Host-infinyx_identity_tx";
export const IDENTITY_STEP_UP_COOKIE_NAME = "__Host-infinyx_stepup";

export function createIdentitySecurityCookie(
  value: string,
  purpose: "transaction" | "stepup" = "transaction"
): string {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new TypeError("Invalid identity security cookie.");
  }
  const name = purpose === "stepup"
    ? IDENTITY_STEP_UP_COOKIE_NAME
    : IDENTITY_SECURITY_TRANSACTION_COOKIE_NAME;
  return [
    `${name}=${value}`,
    "Path=/",
    "Secure",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=300"
  ].join("; ");
}

export function createExpiredIdentitySecurityCookie(): string {
  return [
    `${IDENTITY_SECURITY_TRANSACTION_COOKIE_NAME}=`,
    "Path=/",
    "Secure",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0"
  ].join("; ");
}

export function createExpiredStepUpCookie(): string {
  return [
    `${IDENTITY_STEP_UP_COOKIE_NAME}=`,
    "Path=/",
    "Secure",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0"
  ].join("; ");
}

export function readIdentitySecurityCookie(
  header: string | undefined,
  purpose: "transaction" | "stepup" = "transaction"
): string | null {
  if (typeof header !== "string" || Buffer.byteLength(header, "utf8") > MAX_COOKIE_HEADER_BYTES) {
    return null;
  }
  const name = purpose === "stepup"
    ? IDENTITY_STEP_UP_COOKIE_NAME
    : IDENTITY_SECURITY_TRANSACTION_COOKIE_NAME;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    return /^[A-Za-z0-9_-]{43}$/u.test(value) ? value : null;
  }
  return null;
}
