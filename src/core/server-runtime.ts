import type { Server } from "node:http";
import type { Express } from "express";
import type { Logger } from "pino";
import type { CoreEngine } from "./core-engine.js";

export interface ServerRuntimeOptions {
  readonly app: Express;
  readonly core: CoreEngine;
  readonly process: NodeJS.Process;
  readonly exit: (code: number) => void;
  readonly logger: Pick<Logger, "info" | "error">;
  readonly host: string;
  readonly port: number;
  readonly environment: string;
  readonly drainTimeoutMs?: number;
}

export interface ServerRuntime {
  readonly server: Server;
  readonly shutdown: (reason?: string, fatal?: boolean) => Promise<void>;
}

class ShutdownController {
  private server: Server | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private exitPromise: Promise<void> | undefined;
  private finalExitCode = 0;

  constructor(private readonly options: ServerRuntimeOptions) {}

  install(): void {
    this.options.process.on("SIGINT", () => {
      void this.shutdown("SIGINT");
    });
    this.options.process.on("SIGTERM", () => {
      void this.shutdown("SIGTERM");
    });
    this.options.process.on("uncaughtException", (error: Error) => {
      void this.shutdown("uncaughtException", true, error);
    });
    this.options.process.on("unhandledRejection", (reason: unknown) => {
      void this.shutdown("unhandledRejection", true, reason);
    });
  }

  attachServer(server: Server): void {
    this.server = server;
  }

  shutdown(reason = "manual", fatal = false, error?: unknown): Promise<void> {
    if (fatal) {
      this.finalExitCode = 1;
      this.options.logger.error(
        { reason, err: error },
        "Fatal process error; shutdown requested"
      );
    } else {
      this.options.logger.info({ reason }, "Shutdown requested");
    }

    this.shutdownPromise ??= this.performShutdown();
    return this.shutdownPromise;
  }

  private async performShutdown(): Promise<void> {
    try {
      if (this.server) {
        await this.drainHttpServer(this.server);
      }
    } catch (error) {
      this.finalExitCode = 1;
      this.options.logger.error({ err: error }, "HTTP server drain failed");
    }

    try {
      await this.options.core.stop();
    } catch (error) {
      this.finalExitCode = 1;
      this.options.logger.error({ err: error }, "Core Engine shutdown failed");
    }

    await this.exitOnce();
  }

  private drainHttpServer(server: Server): Promise<void> {
    const timeoutMs = this.options.drainTimeoutMs ?? 10_000;

    return new Promise((resolve) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) {
          this.finalExitCode = 1;
          this.options.logger.error({ err: error }, "HTTP server close failed");
        }
        resolve();
      };

      const timeout = setTimeout(() => {
        if (settled) return;
        this.finalExitCode = 1;
        this.options.logger.error(
          { timeoutMs },
          "HTTP server drain timed out; closing remaining connections"
        );
        server.closeAllConnections();
        finish();
      }, timeoutMs);

      server.close((error) => finish(error));
    });
  }

  private exitOnce(): Promise<void> {
    this.exitPromise ??= Promise.resolve().then(() => {
      this.options.process.exitCode = this.finalExitCode;
      this.options.exit(this.finalExitCode);
    });
    return this.exitPromise;
  }
}

export async function startServerRuntime(
  options: ServerRuntimeOptions
): Promise<ServerRuntime> {
  await options.core.initialize();
  await options.core.start();

  const shutdown = new ShutdownController(options);
  // Register every process-level shutdown handler before listen() can accept traffic.
  shutdown.install();

  const server = options.app.listen(options.port, options.host, () => {
    options.logger.info(
      {
        host: options.host,
        port: options.port,
        environment: options.environment
      },
      "INFINYX HTTP server started"
    );
  });
  shutdown.attachServer(server);

  return {
    server,
    shutdown: (reason, fatal) => shutdown.shutdown(reason, fatal)
  };
}
