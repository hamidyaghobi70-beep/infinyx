import { Server } from "node:http";
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
  readonly startupTimeoutMs?: number;
}

export interface ServerRuntime {
  readonly server: Server;
  readonly shutdown: (reason?: string, fatal?: boolean) => Promise<void>;
}

class ShutdownController {
  private server: Server | undefined;
  private startupPromise: Promise<void> | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private exitPromise: Promise<void> | undefined;
  private shutdownRequested = false;
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

  attachStartup(startupPromise: Promise<void>): void {
    this.startupPromise = startupPromise;
  }

  isShutdownRequested(): boolean {
    return this.shutdownRequested;
  }

  attachServer(server: Server): void {
    this.server = server;
  }

  shutdown(reason = "manual", fatal = false, error?: unknown): Promise<void> {
    this.shutdownRequested = true;
    this.options.core.requestClose?.();
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
    // A signal during initialize/start must not race an in-flight lifecycle hook.
    // Bound the wait so a permanently pending startup cannot suppress process shutdown.
    if (this.startupPromise) {
      const startupSettled = await this.waitForStartup();
      if (!startupSettled) {
        await this.exitOnce();
        return;
      }
    }

    try {
      if (this.server?.listening) {
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

  private async waitForStartup(): Promise<boolean> {
    const timeoutMs = this.options.startupTimeoutMs ?? 10_000;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const timedOut = new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), timeoutMs);
    });
    const settled = this.startupPromise!.then(
      () => true,
      (error: unknown) => {
        this.finalExitCode = 1;
        this.options.logger.error(
          { err: error },
          "Application startup failed during shutdown"
        );
        return true;
      }
    );

    const result = await Promise.race([settled, timedOut]);
    if (timeout) clearTimeout(timeout);

    if (!result) {
      this.finalExitCode = 1;
      this.options.logger.error(
        { timeoutMs },
        "Application startup did not settle before shutdown timeout"
      );
    }
    return result;
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
        server.closeAllConnections?.();
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
  const shutdown = new ShutdownController(options);
  // Install handlers and publish the startup promise before any startup hook runs.
  shutdown.install();

  const startupPromise = Promise.resolve().then(async () => {
    await options.core.initialize();
    // If a signal arrived during initialization, do not start modules just to stop them.
    if (!shutdown.isShutdownRequested()) {
      await options.core.start();
    }
  });
  shutdown.attachStartup(startupPromise);

  try {
    await startupPromise;
  } catch (error) {
    if (shutdown.isShutdownRequested()) {
      await shutdown.shutdown("startup-failed", true, error);
    }
    throw error;
  }

  if (shutdown.isShutdownRequested()) {
    // Startup was interrupted by a signal. Return a non-listening server handle;
    // no HTTP traffic is accepted while the pending shutdown completes.
    return {
      server: new Server(),
      shutdown: (reason, fatal) => shutdown.shutdown(reason, fatal)
    };
  }

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
