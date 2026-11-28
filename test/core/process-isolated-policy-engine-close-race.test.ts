import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

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
import { ProcessIsolatedPolicyEngine } from "../../src/core/process-isolated-policy-engine.js";
import type { PolicyRequest } from "../../src/core/contracts.js";

const fixtureUrl = pathToFileURL(fileURLToPath(
  new URL("../fixtures/policy-evaluator-fixture.mjs", import.meta.url)
)).href;

const allowRequest: PolicyRequest = {
  actorId: "issue-31-race-test",
  action: "allow",
  resource: "policy:terminal-commitment"
};

function stateRecorder(): {
  readonly states: string[];
  readonly onStateChange: (event: { state: string }) => void;
  waitFor(state: string): Promise<void>;
} {
  const states: string[] = [];
  const waiters = new Map<string, (() => void)[]>();

  return {
    states,
    onStateChange: ({ state }) => {
      states.push(state);
      const pending = waiters.get(state);
      if (pending) {
        waiters.delete(state);
        for (const resolve of pending) resolve();
      }
    },
    waitFor: (state) => {
      if (states.includes(state)) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const pending = waiters.get(state) ?? [];
        pending.push(resolve);
        waiters.set(state, pending);
      });
    }
  };
}

function holdNextChildClose(): {
  readonly closeHeld: Promise<void>;
  releaseClose(): void;
  reset(): void;
} {
  let resolveCloseHeld!: () => void;
  const closeHeld = new Promise<void>((resolve) => {
    resolveCloseHeld = resolve;
  });
  let release: (() => void) | undefined;

  forkControl.implementation = (...args: unknown[]) => {
    const child = (forkControl.realFork as (...args: Parameters<typeof fork>) => ReturnType<typeof fork>)(
      ...(args as Parameters<typeof fork>)
    );
    const mutableChild = child as unknown as {
      emit: (...args: unknown[]) => boolean;
    };
    const originalEmit = (child.emit as (...args: unknown[]) => boolean).bind(child);

    mutableChild.emit = ((event: string | symbol, ...payload: unknown[]) => {
      if (event === "close") {
        release = () => originalEmit("close", ...payload);
        resolveCloseHeld();
        return true;
      }
      return originalEmit(event, ...payload);
    }) as (...args: unknown[]) => boolean;

    return child;
  };

  return {
    closeHeld,
    releaseClose: () => {
      const current = release;
      if (!current) throw new Error("The real child close event has not been held.");
      release = undefined;
      current();
    },
    reset: () => {
      forkControl.implementation = undefined;
      if (release) {
        const current = release;
        release = undefined;
        current();
      }
    }
  };
}

async function waitForEvent(promise: Promise<void>, timeoutMs: number): Promise<void> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error("Timed out waiting for the real child close event.")),
          timeoutMs
        );
      })
    ]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

describe("Issue #31 terminal commitment versus child close ordering", () => {
  it("commits allow when the real child close event is released before the deadline", async () => {
    const closeGate = holdNextChildClose();
    const observer = stateRecorder();
    const engine = new ProcessIsolatedPolicyEngine({
      moduleUrl: fixtureUrl,
      timeoutMs: 5_000,
      onStateChange: observer.onStateChange
    });

    try {
      const evaluation = engine.evaluateDetailed(allowRequest);
      await observer.waitFor("FINALIZING");
      await waitForEvent(closeGate.closeHeld, 3_000);

      closeGate.releaseClose();
      const result = await evaluation;

      expect(result.outcome).toBe("COMPLETED");
      expect(result.decision.effect).toBe("allow");
      expect(observer.states).toContain("AUTHORIZED");
      expect(result.stopReason).toBeUndefined();
      expect(engine.activeExecutionCount).toBe(0);
    } finally {
      closeGate.reset();
    }
  });

  it("vetoes allow when the deadline event is released before the held real child close event", async () => {
    const closeGate = holdNextChildClose();
    const observer = stateRecorder();
    const engine = new ProcessIsolatedPolicyEngine({
      moduleUrl: fixtureUrl,
      timeoutMs: 2_500,
      terminationGraceMs: 0,
      killWaitMs: 1_000,
      onStateChange: observer.onStateChange
    });

    try {
      const evaluation = engine.evaluateDetailed({
        ...allowRequest,
        action: "allow-with-active-handle"
      });
      await observer.waitFor("FINALIZING");

      // The evaluator has returned allow but its active handle keeps the real
      // child alive. The deadline must win and initiate termination first.
      await observer.waitFor("STOP_REQUESTED");
      await waitForEvent(closeGate.closeHeld, 3_000);
      expect(observer.states).not.toContain("AUTHORIZED");

      closeGate.releaseClose();
      const result = await evaluation;

      expect(result.outcome).toBe("TIMED_OUT");
      expect(result.stopReason).toBe("POLICY_TIMEOUT");
      expect(result.decision.effect).toBe("deny");
      expect(observer.states).not.toContain("AUTHORIZED");
      expect(engine.activeExecutionCount).toBe(0);
    } finally {
      closeGate.reset();
    }
  });
});
