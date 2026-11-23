import { createApp } from "./api/app.js";
import { CoreEngine } from "./core/core-engine.js";
import { loadConfig } from "./core/config.js";
import { logger } from "./core/logger.js";
import { startServerRuntime } from "./core/server-runtime.js";
import { createJwtPrincipalVerifier, createBearerAuthMiddleware } from "./core/authenticated-principal.js";

const config = loadConfig();
const core = new CoreEngine();
const authIssuer = process.env.AUTH_ISSUER;
const authAudience = process.env.AUTH_AUDIENCE;
const authPublicKey = process.env.AUTH_PUBLIC_KEY_PEM?.replace(/\\n/g, "\n");
const authConfigured = [authIssuer, authAudience, authPublicKey].filter(Boolean).length;
if (authConfigured !== 0 && authConfigured !== 3) {
  throw new Error("AUTH_ISSUER, AUTH_AUDIENCE and AUTH_PUBLIC_KEY_PEM must be configured together.");
}
const authenticate = authConfigured === 3
  ? createBearerAuthMiddleware(createJwtPrincipalVerifier({ issuer: authIssuer!, audience: authAudience!, publicKeyPem: authPublicKey! }))
  : undefined;
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
