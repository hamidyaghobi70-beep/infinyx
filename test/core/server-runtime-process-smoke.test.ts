import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve a local TCP port.");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return port;
}

const builtServer = "dist/server.js";

describe("Built INFINYX server runtime", () => {
  it.skipIf(!existsSync(builtServer))(
    "starts the real server, serves GET /health, and shuts down on SIGTERM",
    async () => {
      const port = await reservePort();
      const child = spawn(process.execPath, [builtServer], {
        env: {
          ...process.env,
          HOST: "127.0.0.1",
          PORT: String(port),
          NODE_ENV: "test"
        },
        stdio: ["ignore", "pipe", "pipe"]
      });

      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr += String(chunk).slice(0, 8_000 - stderr.length);
      });

      let response: Response | undefined;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) {
          throw new Error("Server process exited before becoming healthy. " + stderr);
        }
        try {
          response = await fetch(`http://127.0.0.1:${port}/health`);
          if (response.ok) break;
        } catch {
          // The server may still be starting; retry until the bounded deadline.
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      expect(response?.status, stderr).toBe(200);
      await expect(response!.json()).resolves.toEqual({ status: "ok" });

      const exited = new Promise<number | null>((resolve) => {
        child.once("exit", (code) => resolve(code));
      });
      child.kill("SIGTERM");
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const exitCode = await Promise.race([
        exited,
        new Promise<number | null>((resolve) => {
          killTimer = setTimeout(() => {
            child.kill("SIGKILL");
            resolve(null);
          }, 5_000);
        })
      ]);
      if (killTimer !== undefined) clearTimeout(killTimer);
      expect(exitCode, stderr).toBe(0);
    },
    20_000
  );
});
