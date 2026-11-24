import { app } from "./api/app.js";
import { CoreEngine } from "./core/core-engine.js";
import { createShutdownCoordinator } from "./core/shutdown-coordinator.js";
import { loadConfig } from "./core/config.js";
import { logger } from "./core/logger.js";

const config = loadConfig();
const core = new CoreEngine();

await core.initialize();
await core.start();

const server = app.listen(config.PORT, config.HOST, () => {
  logger.info(
    { host: config.HOST, port: config.PORT, environment: config.NODE_ENV },
    "INFINYX HTTP server started"
  );
});

const shutdown = createShutdownCoordinator({
  closeServer: () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    }),
  stopCore: () => core.stop(),
  onStart: (signal) => logger.info({ signal }, "Shutdown requested"),
  onFailure: (stage, error) => {
    logger.error({ err: error, stage }, "Shutdown step failed");
    process.exitCode = 1;
  }
});

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
