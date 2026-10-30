import { app } from "./api/app.js";
import { CoreEngine } from "./core/core-engine.js";
import { loadConfig } from "./core/config.js";
import { logger } from "./core/logger.js";

const config = loadConfig();
const core = new CoreEngine();

// The composition root owns the platform lifecycle. Register application modules
// before initialization as those modules are introduced in later phases.
await core.initialize();
await core.start();

const server = app.listen(config.PORT, config.HOST, () => {
  logger.info(
    { host: config.HOST, port: config.PORT, environment: config.NODE_ENV },
    "INFINYX HTTP server started"
  );
});

function shutdown(signal: string): void {
  logger.info({ signal }, "Shutdown requested");
  server.close((error) => {
    void (async () => {
      if (error) {
        logger.error({ err: error }, "HTTP server shutdown failed");
        process.exitCode = 1;
      }

      try {
        await core.stop();
      } catch (stopError) {
        logger.error({ err: stopError }, "Core Engine shutdown failed");
        process.exitCode = 1;
      }
    })();
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
