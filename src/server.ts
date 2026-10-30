import { app } from "./api/app.js";
import { CoreEngine } from "./core/core-engine.js";
import { loadConfig } from "./core/config.js";
import { logger } from "./core/logger.js";
import { startServerRuntime } from "./core/server-runtime.js";

const config = loadConfig();
const core = new CoreEngine();

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
