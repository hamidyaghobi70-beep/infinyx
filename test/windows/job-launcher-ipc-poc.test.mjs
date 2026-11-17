import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const launcher = process.env.INFINYX_JOB_LAUNCHER_POC;
const fixture = fileURLToPath(new URL("./ipc-child.mjs", import.meta.url));

test("Windows Job Object launcher transparently preserves Node IPC and stdio", {
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
  const waitForMessage = async (type) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const found = messages.find((message) => message?.type === type);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for IPC message: ${type}; received ${JSON.stringify(messages)}`);
  };

  try {
    child.send({ type: "evaluate", requestId: "ipc-poc-001" });
    assert.deepEqual(await waitForMessage("started"), {
      type: "started",
      requestId: "ipc-poc-001"
    });

    child.send({ type: "cancel", reason: "POC_CANCEL" });
    assert.deepEqual(await waitForMessage("cancelled"), {
      type: "cancelled",
      reason: "POC_CANCEL"
    });

    child.send({ type: "finalize" });
    assert.deepEqual(await waitForMessage("finalized"), { type: "finalized" });

    const [code, signal] = await once(child, "close");
    assert.equal(signal, null);
    assert.equal(code, 0);
    assert.match(stdout, /POC_STDOUT/);
    assert.match(stderr, /POC_STDERR/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  }
});
