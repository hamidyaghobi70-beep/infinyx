import type { IncomingMessage } from "node:http";
import { verifyCsrfToken } from "./session-crypto.js";
import type { StoredWebSession } from "./session-store.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const ORIGIN_MAX_LENGTH = 2048;

export type CsrfValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "origin" | "token" };

export function validateBffCsrf(
  request: Pick<IncomingMessage, "method" | "headers">,
  session: Pick<StoredWebSession, "csrfTokenHash">,
  expectedOrigin: string
): CsrfValidationResult {
  const method = request.method?.toUpperCase() ?? "";
  if (SAFE_METHODS.has(method)) return Object.freeze({ ok: true });

  if (!isCanonicalOrigin(expectedOrigin)) {
    return Object.freeze({ ok: false, reason: "origin" });
  }
  const origin = request.headers.origin;
  if (typeof origin !== "string" || origin.length > ORIGIN_MAX_LENGTH ||
      origin !== expectedOrigin) {
    return Object.freeze({ ok: false, reason: "origin" });
  }

  const token = request.headers["x-infinyx-csrf"];
  if (typeof token !== "string" || !verifyCsrfToken(token, session.csrfTokenHash)) {
    return Object.freeze({ ok: false, reason: "token" });
  }
  return Object.freeze({ ok: true });
}

function isCanonicalOrigin(value: string): boolean {
  if (typeof value !== "string" || value.length < 1 || value.length > ORIGIN_MAX_LENGTH) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return parsed.origin === value &&
      (parsed.protocol === "https:" || parsed.hostname === "localhost") &&
      parsed.username === "" && parsed.password === "" &&
      parsed.pathname === "/" && parsed.search === "" && parsed.hash === "";
  } catch {
    return false;
  }
}
