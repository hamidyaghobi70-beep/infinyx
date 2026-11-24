import { createApp } from "./api/app.js";
import { CoreEngine } from "./core/core-engine.js";
import { loadConfig } from "./core/config.js";
import { logger } from "./core/logger.js";
import { startServerRuntime } from "./core/server-runtime.js";
import { createJwtPrincipalVerifier, createBearerAuthMiddleware, createJwksJwtPrincipalVerifier, createAsyncBearerAuthMiddleware } from "./core/authenticated-principal.js";
import { JwksKeyResolver } from "./core/jwks-key-resolver.js";

const config = loadConfig();
const core = new CoreEngine();
const authIssuer = process.env.AUTH_ISSUER;
const authAudience = process.env.AUTH_AUDIENCE;
const authPublicKey = process.env.AUTH_PUBLIC_KEY_PEM?.replace(/\\n/g, "\n");
const authJwksUrl = process.env.AUTH_JWKS_URL;
const authConfigured = [authIssuer, authAudience, authPublicKey, authJwksUrl].filter(Boolean).length;

if (config.NODE_ENV === "production" && authConfigured === 0) {
  throw new Error("Production startup requires a trusted authentication configuration.");
}
if (authConfigured !== 0 && (!authIssuer || !authAudience || Boolean(authPublicKey) === Boolean(authJwksUrl))) {
  throw new Error("Configure AUTH_ISSUER and AUTH_AUDIENCE with exactly one of AUTH_PUBLIC_KEY_PEM or AUTH_JWKS_URL.");
}
const authenticate = authConfigured === 0
  ? undefined
  : authJwksUrl
    ? createAsyncBearerAuthMiddleware(createJwksJwtPrincipalVerifier(
        { issuer: authIssuer!, audience: authAudience! },
        new JwksKeyResolver({ jwksUrl: authJwksUrl })
      ))
    : createBearerAuthMiddleware(createJwtPrincipalVerifier({
        issuer: authIssuer!, audience: authAudience!, publicKeyPem: authPublicKey!
      }));
const app = createApp(() => core.state === "running", authenticate);

await startServerRuntime({
  app,
  core,
  process,
  exit: (code) => process.exit(code),
  logger,
  host: config.HOST,
  port: config.PORT,
  environment: config.NODE_ENV,
  drainTimeoutMs: 10_000
});
