import { createApp } from "./api/app.js";
import { CoreEngine } from "./core/core-engine.js";
import { loadConfig } from "./core/config.js";
import { logger } from "./core/logger.js";
import { startServerRuntime } from "./core/server-runtime.js";
import { createJwtPrincipalVerifier, createBearerAuthMiddleware } from "./core/authenticated-principal.js";

const config = loadConfig();
const core = new CoreEngine();
const authIssuer = process.env.AUTH_ISSUER;\nconst authAudience = process.env.AUTH_AUDIENCE;\nconst authPublicKey = process.env.AUTH_PUBLIC_KEY_PEM?.replace(/\\\\n/g, "\\n");\nconst authConfigured = [authIssuer, authAudience, authPublicKey].filter(Boolean).length;\nif (authConfigured !== 0 && authConfigured !== 3) {\n  throw new Error("AUTH_ISSUER, AUTH_AUDIENCE and AUTH_PUBLIC_KEY_PEM must be configured together.");\n}\nconst authenticate = authConfigured === 3\n  ? createBearerAuthMiddleware(createJwtPrincipalVerifier({ issuer: authIssuer!, audience: authAudience!, publicKeyPem: authPublicKey! }))\n  : undefined;\nconst app = createApp(() => core.state === "running", authenticate);

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
