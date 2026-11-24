import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

function waitForReady(child: ReturnType<typeof spawn>, output: () => string): Promise<void> {
  return new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => rejectReady(new Error("Child process did not become ready.")), 10_000);
    const check = (): void => {
      if (output().includes("READY")) {
        clearTimeout(timeout);
        resolveReady();
      }
    };
    child.stdout?.on("data", check);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectReady(error);
    });
    child.once("exit", (code, signal) => {
      if (!output().includes("READY")) {
        clearTimeout(timeout);
        rejectReady(new Error(`Child exited before READY (code=${code}, signal=${signal}).`));
      }
    });
    check();
  });
}

describe("OS child-process signal handling", () => {
  it.each(["SIGINT", "SIGTERM"] as const)(
    "CP01: receives real operating-system %s and performs one orderly shutdown",
    async (signal) => {
      const runtimeUrl = pathToFileURL(resolve(process.cwd(), "dist/core/server-runtime.js")).href;
      const engineUrl = pathToFileURL(resolve(process.cwd(), "dist/core/core-engine.js")).href;
      const script = `
        import express from "express";
        import { CoreEngine } from ${JSON.stringify(engineUrl)};
        import { startServerRuntime } from ${JSON.stringify(runtimeUrl)};
        const core = new CoreEngine();
        core.register({
          id: "child-process-probe",
          version: "1.0.0",
          stop: () => { process.stdout.write("STOPPED\\n"); }
        });
        await startServerRuntime({
          app: express(),
          core,
          process,
          exit: (code) => process.stdout.write("EXIT:" + code + "\\n", () => process.exit(code)),
          logger: { info: () => undefined, error: () => undefined },
          host: "127.0.0.1",
          port: 0,
          environment: "test",
          drainTimeoutMs: 1000
        });
        process.stdout.write("READY\\n");
      `;
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr?.on("data", (chunk: string) => { stderr += chunk; });

      try {
        await waitForReady(child, () => stdout);
        const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
          child.once("exit", (code, exitSignal) => resolveExit({ code, signal: exitSignal }));
        });
        expect(child.kill(signal)).toBe(true);
        const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
          const timeout = setTimeout(() => reject(new Error("Child process shutdown timed out.")), 10_000);
          exited.then(
            (value) => {
              clearTimeout(timeout);
              resolveExit(value);
            },
            (error: unknown) => {
              clearTimeout(timeout);
              reject(error);
            }
          );
        });

        expect(result.code).toBe(0);
        expect(result.signal).toBeNull();
        expect(stdout.match(/STOPPED/g)).toHaveLength(1);
        expect(stdout).toContain("EXIT:0");
        expect(stderr).toBe("");
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
    },
    15_000
  );

  it("CP02: exits non-zero after drain timeout while an accepted operation is still active", async () => {
    const runtimeUrl = pathToFileURL(resolve(process.cwd(), "dist/core/server-runtime.js")).href;
    const engineUrl = pathToFileURL(resolve(process.cwd(), "dist/core/core-engine.js")).href;
    const script = `
      import express from "express";
      import { CoreEngine } from ${JSON.stringify(engineUrl)};
      import { startServerRuntime } from ${JSON.stringify(runtimeUrl)};
      let markActive;
      const active = new Promise((resolve) => { markActive = resolve; });
      const core = new CoreEngine({ operationDrainTimeoutMs: 150 });
      core.events.subscribe("blocked-operation", async () => {
        markActive();
        await new Promise(() => undefined);
      });
      await startServerRuntime({
        app: express(),
        core,
        process,
        exit: (code) => process.stdout.write("EXIT:" + code + "\\n", () => process.exit(code)),
        logger: { info: () => undefined, error: () => undefined },
        host: "127.0.0.1",
        port: 0,
        environment: "test",
        drainTimeoutMs: 1000
      });
      const pending = core.events.publish("blocked-operation", {});
      await active;
      process.stdout.write("ACTIVE\\n");
      process.stdout.write("READY\\n");
      void pending;
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });

    try {
      await waitForReady(child, () => stdout);
      expect(stdout).toContain("ACTIVE");
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
        child.once("exit", (code, exitSignal) => resolveExit({ code, signal: exitSignal }));
      });
      expect(child.kill("SIGTERM")).toBe(true);
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
        const timeout = setTimeout(() => reject(new Error("Child process did not exit after Core Engine drain timeout.")), 10_000);
        exited.then(
          (value) => {
            clearTimeout(timeout);
            resolveExit(value);
          },
          (error: unknown) => {
            clearTimeout(timeout);
            reject(error);
          }
        );
      });

      expect(result.code).toBe(1);
      expect(result.signal).toBeNull();
      expect(stdout).toContain("EXIT:1");
      expect(stdout).not.toContain("STOPPED");
      expect(stderr).toBe("");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 15_000);

});
