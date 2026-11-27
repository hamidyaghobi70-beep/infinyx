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
