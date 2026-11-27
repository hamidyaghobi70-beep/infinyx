import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { createCsrfToken, hashCsrfToken } from "./session-crypto.js";
import { validateBffCsrf } from "./csrf.js";

function request(method: string, origin?: string, token?: string): Pick<IncomingMessage, "method" | "headers"> {
  return {
    method,
    headers: {
      ...(origin === undefined ? {} : { origin }),
      ...(token === undefined ? {} : { "x-infinyx-csrf": token })
    }
  } as Pick<IncomingMessage, "method" | "headers">;
}

describe("BFF CSRF validation", () => {
  const csrf = createCsrfToken();
  const session = { csrfTokenHash: hashCsrfToken(csrf) };

  it("allows safe methods without a CSRF token", () => {
    expect(validateBffCsrf(request("GET"), session, "https://app.infinyx.test").ok).toBe(true);
    expect(validateBffCsrf(request("HEAD"), session, "https://app.infinyx.test").ok).toBe(true);
  });

  it("requires exact same-origin and a matching synchronizer token for mutations", () => {
    expect(validateBffCsrf(request("POST", "https://app.infinyx.test", csrf), session, "https://app.infinyx.test").ok).toBe(true);
    expect(validateBffCsrf(request("POST", "https://evil.test", csrf), session, "https://app.infinyx.test")).toEqual({ ok: false, reason: "origin" });
    expect(validateBffCsrf(request("POST", "https://app.infinyx.test", "wrong"), session, "https://app.infinyx.test")).toEqual({ ok: false, reason: "token" });
    expect(validateBffCsrf(request("DELETE"), session, "https://app.infinyx.test")).toEqual({ ok: false, reason: "origin" });
  });

  it("rejects malformed or non-canonical configured origins", () => {
    expect(validateBffCsrf(request("POST", "https://app.infinyx.test", csrf), session, "https://app.infinyx.test/path").ok).toBe(false);
    expect(validateBffCsrf(request("POST", "http://app.infinyx.test", csrf), session, "http://app.infinyx.test").ok).toBe(false);
  });
});
