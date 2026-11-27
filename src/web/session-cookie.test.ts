import { describe, expect, it } from "vitest";
import {
  createExpiredSessionCookie,
  createSessionCookie,
  readSessionCookie,
  SESSION_COOKIE_NAME
} from "./session-cookie.js";
import { createOpaqueSessionId } from "./session-crypto.js";

describe("web session cookies", () => {
  it("sets a host-only secure HttpOnly cookie", () => {
    const cookie = createSessionCookie(createOpaqueSessionId(), { secure: true, maxAgeSeconds: 900 });
    expect(cookie).toContain("__Host-infinyx_session=");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=900");
    expect(cookie.toLowerCase()).not.toContain("domain=");
  });

  it("refuses insecure cookie configuration", () => {
    expect(() => createSessionCookie(createOpaqueSessionId(), { secure: false })).toThrow();
  });

  it("reads only a well-formed session cookie", () => {
    const id = createOpaqueSessionId();
    expect(readSessionCookie(`other=x; ${SESSION_COOKIE_NAME}=${id}`)).toBe(id);
    expect(readSessionCookie(`${SESSION_COOKIE_NAME}=bad`)).toBeNull();
    expect(readSessionCookie("x".repeat(9000))).toBeNull();
    expect(readSessionCookie(undefined)).toBeNull();
  });

  it("expires the cookie with matching security attributes", () => {
    const cookie = createExpiredSessionCookie();
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });
});
