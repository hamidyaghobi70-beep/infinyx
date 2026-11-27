import { generateKeyPairSync, sign } from "node:crypto";
import {
  createAuthenticatedPrincipalResolver,
  createOidcJwksPrincipalVerifier,
  type AuthenticatedPrincipal
} from "../authenticated-principal.js";

export interface TestPrincipalOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly subject: string;
  readonly userId: string;
  readonly tenantId?: string;
}

export async function createTestPrincipal(
  options: TestPrincipalOptions
): Promise<AuthenticatedPrincipal> {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const now = Math.floor(Date.now() / 1000);
  const jwk = {
    ...keys.publicKey.export({ format: "jwk" }),
    kid: "test-key",
    use: "sig",
    alg: "RS256"
  };
  const fetcher: typeof fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/.well-known/openid-configuration")) {
      return new Response(JSON.stringify({
        issuer: options.issuer,
        jwks_uri: `${options.issuer.replace(/\/$/u, "")}/test-jwks`
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
  };
  const verifier = createOidcJwksPrincipalVerifier({
    issuer: options.issuer,
    audience: options.audience,
    authorizedParties: ["infinyx-test-client"],
    accessTokenType: "Bearer",
    now: () => now,
    fetcher
  });
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = [
    encode({ alg: "RS256", typ: "JWT", kid: "test-key" }),
    encode({
      iss: options.issuer,
      aud: options.audience,
      sub: options.subject,
      exp: now + 300,
      iat: now - 10,
      typ: "Bearer",
      azp: "infinyx-test-client",
      ...(options.tenantId ? { tenant_id: options.tenantId } : {})
    })
  ].join(".");
  const jwt = `${input}.${sign("RSA-SHA256", Buffer.from(input), keys.privateKey).toString("base64url")}`;
  const identity = await verifier(jwt);
  return createAuthenticatedPrincipalResolver(() => options.userId)(identity);
}
