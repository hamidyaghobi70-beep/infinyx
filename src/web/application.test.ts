import { describe, expect, it } from "vitest";
import { readWebBffRuntimeConfiguration } from "./application.js";

const validEnvironment = {
  OIDC_ISSUER: "https://identity.infinyx.test",
  OIDC_CLIENT_ID: "infinyx-web",
  OIDC_CLIENT_SECRET: "synthetic-client-secret",
  OIDC_REDIRECT_URI: "https://app.infinyx.test/auth/callback",
  PUBLIC_ORIGIN: "https://app.infinyx.test",
  SESSION_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64")
};

describe("Web BFF runtime configuration", () => {
  it("parses a secure provider and server configuration", () => {
    const config = readWebBffRuntimeConfiguration({
      ...validEnvironment,
      HOST: "127.0.0.1",
      PORT: "8080"
    });
    expect(config.oidc.issuer).toBe(validEnvironment.OIDC_ISSUER);
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(8080);
    expect(config.sessionEncryptionKey).toHaveLength(32);
  });

  it("uses safe listener defaults", () => {
    const config = readWebBffRuntimeConfiguration(validEnvironment);
    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(3000);
  });

  it("rejects missing secrets, insecure origins, and invalid ports", () => {
    expect(() => readWebBffRuntimeConfiguration({
      ...validEnvironment,
      SESSION_ENCRYPTION_KEY: ""
    })).toThrow();
    expect(() => readWebBffRuntimeConfiguration({
      ...validEnvironment,
      PUBLIC_ORIGIN: "http://app.infinyx.test",
      OIDC_REDIRECT_URI: "http://app.infinyx.test/auth/callback"
    })).toThrow();
    expect(() => readWebBffRuntimeConfiguration({
      ...validEnvironment,
      PORT: "65536"
    })).toThrow();
  });
});
