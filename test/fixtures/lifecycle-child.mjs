import { once } from "node:events";
import express from "express";
import { CoreEngine } from "../../dist/core/core-engine.js";
import { startServerRuntime } from "../../dist/core/server-runtime.js";

const mode = process.argv[2] ?? "ready";
const core = new CoreEngine();

core.register({
  id: "worker",
  version: "1.0.0",
  initialize: async () => {
    if (mode === "startup") {
      process.stdout.write("INITIALIZING\n");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  },
  start: () => {
    process.stdout.write("STARTED\n");
  },
  stop: () => {
    process.stdout.write("STOPPED\n");
  }
});

const runtime = await startServerRuntime({
  app: express(),
  core,
  process,
  exit: (code) => {
    process.stdout.write(`EXIT:${code}\n`, () => process.exit(code));
  },
  logger: {
    info: () => undefined,
    error: (...args) => process.stderr.write(`${args.map(String).join(" ")}\n`)
  },
  host: "127.0.0.1",
  port: 0,
  environment: "process-signal-test",
  drainTimeoutMs: 1_000
});

if (mode === "ipc") {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    if (chunk.includes("SHUTDOWN")) void runtime.shutdown("IPC");
  });
}

if (mode === "startup" && !runtime.server.listening) {
  // The real signal interrupted startup; shutdown owns the eventual process exit.
  await new Promise(() => undefined);
} else {
  if (!runtime.server.listening) await once(runtime.server, "listening");
  process.stdout.write("READY\n");
}
