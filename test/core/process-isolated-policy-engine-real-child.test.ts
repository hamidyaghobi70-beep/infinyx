import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { fork as ForkType } from "node:child_process";

const forkControl = vi.hoisted(() => ({
  implementation: undefined as ((...args: unknown[]) => unknown) | undefined,
  realFork: undefined as ((...args: unknown[]) => unknown) | undefined
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  forkControl.realFork = actual.fork as (...args: unknown[]) => unknown;
  return {
    ...actual,
    fork: ((...args: unknown[]) => {
      if (forkControl.implementation) return forkControl.implementation(...args);
      return actual.fork(...args);
    }) as typeof actual.fork
  };
});

import { fork } from "node:child_process";
import { CoreEngine } from "../../src/core/core-engine.js";
import { ProcessIsolatedPolicyEngine } from "../../src/core/process-isolated-policy-engine.js";
import type { PolicyRequest } from "../../src/core/contracts.js";

const fixtureUrl = pathToFileURL(fileURLToPath(
  new URL("../fixtures/policy-evaluator-fixture.mjs", import.meta.url)
)).href;
const request: PolicyRequest = {
  actorId: "core",
  action: "hang",
  resource: "policy:test"
};

function observeRunning(): { reached: Promise<void>; onStateChange: (event: { state: string }) => void } {
  let resolve!: () => void;
  const reached = new Promise<void>((done) => { resolve = done; });
  return {
    reached,
    onStateChange: (event) => {
      if (event.state === "RUNNING") resolve();
    }
  };
}

describe("ProcessIsolatedPolicyEngine real child shutdown", () => {
  it("waits for the actual child close event before retrying cleanup and records SIGKILL", async () => {
    const killSignals: (NodeJS.Signals | undefined)[] = [];
    let resolveCloseHeld!: () => void;
    const closeHeld = new Promise<void>((resolve) => { resolveCloseHeld = resolve; });
    let releaseClose!: () => void;

    forkControl.implementation = (...args: unknown[]) => {
      const child = (forkControl.realFork as (...args: unknown[]) => ReturnType<typeof fork>)(...args);
      const originalEmit = child.emit.bind(child);
      child.emit = ((event: string | symbol, ...payload: unknown[]) => {
        if (event === "close") {
          releaseClose = () => { originalEmit("close", ...payload); };
          resolveCloseHeld();
          return true;
        }
        return originalEmit(event, ...payload);
      }) as typeof child.emit;
      const originalKill = child.kill.bind(child);
      child.kill = ((signal?: NodeJS.Signals) => {
        killSignals.push(signal);
        return originalKill(signal);
      }) as typeof child.kill;
      return child;
    };

    const observer = observeRunning();
    const runtime = new ProcessIsolatedPolicyEngine({
      moduleUrl: fixtureUrl,
      terminationGraceMs: 0,
      killWaitMs: 5,
      onStateChange: observer.onStateChange
    });
    let cleanupCalls = 0;
    const engine = new CoreEngine({ policy: runtime });
    engine.register({
      id: "worker",
      version: "1.0.0",
      stop: () => { cleanupCalls += 1; }
    });
    await engine.initialize();

    try {
      const evaluation = engine.policy.evaluate(request);
      await observer.reached;
      const stop = engine.stop();
      await closeHeld;
      await expect(stop).rejects.toMatchObject({ code: "POLICY_RUNTIME_UNRESOLVED" });
      await expect(evaluation).resolves.toMatchObject({ effect: "deny" });

      expect(killSignals).toContain("SIGKILL");
      expect(engine.state).toBe("unresolved");
      expect(runtime.activeExecutionCount).toBe(1);
      expect(cleanupCalls).toBe(0);

      await expect(engine.stop()).rejects.toMatchObject({
        code: "POLICY_RUNTIME_UNRESOLVED"
      });
      expect(cleanupCalls).toBe(0);

      releaseClose();
      expect(runtime.activeExecutionCount).toBe(0);
      await engine.stop();
      expect(engine.state).toBe("stopped");
      expect(cleanupCalls).toBe(1);
      await engine.stop();
      expect(cleanupCalls).toBe(1);
    } finally {
      forkControl.implementation = undefined;
      if (releaseClose) releaseClose();
    }
  });
});
