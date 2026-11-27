import { describe, expect, it } from "vitest";
import {
  createExpiredLoginTransactionCookie,
  createLoginTransactionCookie,
  readLoginTransactionCookie,
  LOGIN_TRANSACTION_COOKIE_NAME,
  createAccountRecoveryTransactionCookie,
  createExpiredAccountRecoveryTransactionCookie,
  readAccountRecoveryTransactionCookie,
  ACCOUNT_RECOVERY_TRANSACTION_COOKIE_NAME
} from "./session-cookie.js";
import { createOpaqueSessionId } from "./session-crypto.js";

describe("OIDC login transaction cookie", () => {
  it("uses a short-lived host-only secure HttpOnly cookie", () => {
    const binding = createOpaqueSessionId();
    const cookie = createLoginTransactionCookie(binding);
    expect(cookie).toContain(`${LOGIN_TRANSACTION_COOKIE_NAME}=${binding}`);
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=600");
    expect(cookie.toLowerCase()).not.toContain("domain=");
    expect(readLoginTransactionCookie(cookie.split(";")[0])).toBe(binding);
  });

  it("expires the login cookie after callback", () => {
    const cookie = createExpiredLoginTransactionCookie();
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
  });
});

describe("account recovery transaction cookie", () => {
  it("uses a separate short-lived host-only secure browser binding", () => {
    const binding = createOpaqueSessionId();
    const cookie = createAccountRecoveryTransactionCookie(binding);
    expect(cookie).toContain(`${ACCOUNT_RECOVERY_TRANSACTION_COOKIE_NAME}=${binding}`);
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=300");
    expect(cookie.toLowerCase()).not.toContain("domain=");
    expect(readAccountRecoveryTransactionCookie(cookie.split(";")[0])).toBe(binding);
  });

  it("expires the recovery binding after callback and rejects duplicate cookies", () => {
    const cookie = createExpiredAccountRecoveryTransactionCookie();
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    const binding = createOpaqueSessionId();
    const duplicate = createAccountRecoveryTransactionCookie(binding);
    expect(readAccountRecoveryTransactionCookie(`${duplicate}; ${duplicate}`)).toBeNull();
  });
});
