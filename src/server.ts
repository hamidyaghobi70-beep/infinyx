import { app } from "./api/app.js";
import { loadConfig } from "./core/config.js";
import { logger } from "./core/logger.js";

const config = loadConfig();
const server = app.listen(config.PORT, config.HOST, () => {
  logger.info({ host: config.HOST, port: config.PORT, environment: config.NODE_ENV }, "INFINYX HTTP server started");
});

function shutdown(signal: string): void {
  logger.info({ signal }, "Shutdown requested");
  server.close((error) => {
    if (error) {
      logger.error({ err: error }, "HTTP server shutdown failed");
      process.exitCode = 1;
    }
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
