import * as oidc from "openid-client";
import { describe, expect, it } from "vitest";
import { discoverOidcClient } from "./oidc-bff.js";

const issuer = process.env.KEYCLOAK_INTEGRATION_ISSUER;
const clientId = process.env.KEYCLOAK_INTEGRATION_CLIENT_ID ?? "infinyx-web";
const clientSecret = process.env.KEYCLOAK_INTEGRATION_CLIENT_SECRET ?? "ci-only-infinyx-web-secret";

describe.skipIf(!issuer)("live Keycloak staging integration", () => {
  it("discovers the configured realm over trusted HTTPS and exposes a usable JWKS", async () => {
    const client = await discoverOidcClient({
      issuer: issuer!,
      clientId,
      clientSecret,
      redirectUri: "https://localhost:3000/auth/callback",
      publicOrigin: "https://localhost:3000"
    });

    const metadata = client.serverMetadata();
    expect(metadata.issuer).toBe(issuer);
    expect(metadata.authorization_endpoint).toMatch(/^https:\/\//u);
    expect(metadata.token_endpoint).toMatch(/^https:\/\//u);
    expect(metadata.jwks_uri).toMatch(/^https:\/\//u);

    const authorizationUrl = oidc.buildAuthorizationUrl(client, {
      redirect_uri: "https://localhost:3000/auth/callback",
      response_type: "code",
      scope: "openid",
      state: "ci-integration-state"
    });
    expect(authorizationUrl.origin).toBe("https://localhost:8443");
    expect(authorizationUrl.pathname).toBe("/realms/infinyx-ci/protocol/openid-connect/auth");
    expect(authorizationUrl.searchParams.get("client_id")).toBe(clientId);

    const jwksResponse = await fetch(metadata.jwks_uri!);
    expect(jwksResponse.status).toBe(200);
    const jwks = await jwksResponse.json() as { keys?: unknown[] };
    expect(Array.isArray(jwks.keys)).toBe(true);
    expect(jwks.keys!.length).toBeGreaterThan(0);
  });
});
