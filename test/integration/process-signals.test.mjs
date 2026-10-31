import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("../fixtures/lifecycle-child.mjs", import.meta.url));

function launch(mode) {
  const child = spawn(process.execPath, [fixture, mode], {
    stdio: ["pipe", "pipe", "pipe"]
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

test("real SIGINT during initialization waits for the hook and skips module start", {
  skip: process.platform === "win32" ? "POSIX signal semantics are not available on Windows" : false
}, async (t) => {
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

test("real SIGTERM shuts down a running child process exactly once", {
  skip: process.platform === "win32" ? "POSIX signal semantics are not available on Windows" : false
}, async (t) => {
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

test("a second real signal joins the existing shutdown without rerunning cleanup", {
  skip: process.platform === "win32" ? "POSIX signal semantics are not available on Windows" : false
}, async (t) => {
  const run = launch("double-signal");
  t.after(() => {
    if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill("SIGKILL");
  });

  await waitForOutput(run.child, run.output, "READY");
  const exited = waitForExit(run.child);

  assert.equal(run.child.kill("SIGINT"), true);
  await waitForOutput(run.child, run.output, "CLEANUP_STARTED");
  await waitForOutput(run.child, run.output, "SIGNAL:SIGINT");

  assert.equal(run.child.kill("SIGTERM"), true);
  await waitForOutput(run.child, run.output, "SIGNAL:SIGTERM");

  run.child.stdin.write("RELEASE\n");
  const result = await exited;

  assert.equal(result.code, 0, run.errors());
  assert.equal(result.signal, null);
  assert.equal(count(run.output(), "SIGNAL:SIGINT"), 1);
  assert.equal(count(run.output(), "SIGNAL:SIGTERM"), 1);
  assert.equal(count(run.output(), "CLEANUP_STARTED"), 1);
  assert.equal(count(run.output(), "STOPPED"), 1);
  assert.equal(count(run.output(), "EXIT:0"), 1);
});

test("IPC requests graceful shutdown for platforms without POSIX signal semantics", async (t) => {
  const run = launch("ipc");
  t.after(() => {
    if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill("SIGKILL");
  });

  await waitForOutput(run.child, run.output, "READY");
  const exited = waitForExit(run.child);
  run.child.stdin.write("SHUTDOWN\n");
  const result = await exited;

  assert.equal(result.code, 0, run.errors());
  assert.equal(result.signal, null);
  assert.equal(count(run.output(), "SIGNAL:IPC"), 1);
  assert.equal(count(run.output(), "STOPPED"), 1);
  assert.equal(count(run.output(), "EXIT:0"), 1);
});


for (const mode of ["uncaught", "unhandled"]) {
  test(`fatal process event (${mode}) drains and stops exactly once with exit code 1`, async (t) => {
    const run = launch(mode);
    t.after(() => {
      if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill("SIGKILL");
    });

    await waitForOutput(run.child, run.output, "READY");
    const result = await waitForExit(run.child);

    assert.equal(result.code, 1, run.errors());
    assert.equal(result.signal, null);
    assert.equal(count(run.output(), "STOPPED"), 1);
    assert.equal(count(run.output(), "EXIT:1"), 1);
    assert.match(run.errors(), /Fatal process error; shutdown requested/);
  });
}
