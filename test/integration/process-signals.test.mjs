import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("../fixtures/lifecycle-child.mjs", import.meta.url));

function launch(mode) {
  const child = spawn(process.execPath, [fixture, mode], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return {
    child,
    output: () => stdout,
    errors: () => stderr
  };
}

function waitForOutput(child, output, marker) {
  if (output().includes(marker)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${marker}. stdout=${output()}`));
    }, 8_000);
    const onData = () => {
      if (output().includes(marker)) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`Child exited before ${marker}: code=${code}, signal=${signal}; stdout=${output()}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onData);
    child.once("exit", onExit);
  });
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Child process did not exit after receiving the signal."));
    }, 8_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function count(output, marker) {
  return output.split(marker).length - 1;
}

test("real SIGINT during initialization waits for the hook and skips module start", async (t) => {
  const run = launch("startup");
  t.after(() => {
    if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill("SIGKILL");
  });

  await waitForOutput(run.child, run.output, "INITIALIZING");
  const exited = waitForExit(run.child);
  assert.equal(run.child.kill("SIGINT"), true);
  const result = await exited;

  assert.equal(result.code, 0, run.errors());
  assert.equal(result.signal, null);
  assert.equal(count(run.output(), "STOPPED"), 1);
  assert.equal(count(run.output(), "EXIT:0"), 1);
  assert.match(run.output(), /INITIALIZING/);
  assert.doesNotMatch(run.output(), /STARTED|READY/);
});

test("real SIGTERM shuts down a running child process exactly once", async (t) => {
  const run = launch("ready");
  t.after(() => {
    if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill("SIGKILL");
  });

  await waitForOutput(run.child, run.output, "READY");
  const exited = waitForExit(run.child);
  assert.equal(run.child.kill("SIGTERM"), true);
  const result = await exited;

  assert.equal(result.code, 0, run.errors());
  assert.equal(result.signal, null);
  assert.match(run.output(), /STARTED/);
  assert.equal(count(run.output(), "STOPPED"), 1);
  assert.equal(count(run.output(), "EXIT:0"), 1);
});
