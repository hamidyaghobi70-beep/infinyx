import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const launcher = process.env.INFINYX_JOB_LAUNCHER_POC;
const fixture = fileURLToPath(new URL("./ipc-child.mjs", import.meta.url));

test("records that a raw inherited Node IPC handle is not transparently reusable", {
  skip: process.platform !== "win32" || !launcher
}, async () => {
  const child = spawn(launcher, [process.execPath, fixture], {
    stdio: ["pipe", "pipe", "pipe", "ipc"],
    windowsHide: true
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });

  const messages = [];
  child.on("message", (message) => messages.push(message));

  let closeTimer;
  try {
    child.send({ type: "evaluate", requestId: "ipc-poc-001" });
    const [code, signal] = await Promise.race([
      once(child, "close"),
      new Promise((_, reject) => {
        closeTimer = setTimeout(() => reject(new Error(
          `Launcher did not close after the evaluator IPC write failed; stdout=${stdout}; stderr=${stderr}`
        )), 10_000);
      })
    ]);

    assert.equal(signal, null);
    assert.equal(code, 1);
    assert.deepEqual(messages, []);
    assert.match(stderr, /POC_CHILD_BOOT connected=true/);
    assert.match(stderr, /EPIPE/);
    assert.equal(stdout, "");
  } finally {
    if (closeTimer) clearTimeout(closeTimer);
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
});
