import { createWebBffApplication } from "./application.js";

async function start(): Promise<void> {
  const application = await createWebBffApplication();
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      application.server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      application.server.off("error", onError);
      resolve();
    };
    application.server.once("error", onError);
    application.server.once("listening", onListening);
    application.server.listen(application.port, application.host);
  });

  const revocationRetryTimer = setInterval(() => {
    void application.retryPendingIdentitySessionRevocations().then(failures => {
      if (failures > 0) {
        process.stderr.write("INFINYX has pending identity session revocations requiring retry.\n");
      }
    }).catch(() => {
      process.stderr.write("INFINYX identity session revocation retry failed.\n");
    });
  }, 30_000);

  const accountRevocationRetryTimer = setInterval(() => {
    void application.retryPendingAccountSessionRevocations().then(failures => {
      if (failures > 0) {
        process.stderr.write("INFINYX has pending account session revocations requiring retry.\\n");
      }
    }).catch(() => {
      process.stderr.write("INFINYX account session revocation retry failed.\\n");
    });
  }, 30_000);

  let closing = false;
  const shutdown = () => {
    clearInterval(revocationRetryTimer);\n    clearInterval(accountRevocationRetryTimer);
    if (closing) return;
    closing = true;
    application.server.close((error) => {
      void application.pool.end().finally(() => {
        if (error) process.exitCode = 1;
      });
    });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

void start().catch(() => {
  process.stderr.write("INFINYX Web BFF startup failed. Check deployment configuration and service availability.\n");
  process.exitCode = 1;
});
