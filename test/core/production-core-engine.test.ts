import { describe, expect, it } from "vitest";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createProductionCoreEngine } from "../../src/core/production-core-engine.js";
import { ProcessIsolatedPolicyEngine } from "../../src/core/process-isolated-policy-engine.js";

const fixtureUrl = pathToFileURL(fileURLToPath(
  new URL("../fixtures/policy-evaluator-fixture.mjs", import.meta.url)
)).href;

describe("production CoreEngine composition", () => {
  it("creates the default-deny production engine without a custom evaluator", () => {
    const engine = createProductionCoreEngine();

    expect(engine.state).toBe("created");
    expect(engine.policy.constructor.name).toBe("DefaultDenyPolicyEngine");
  });

  it("rejects an in-process custom evaluator at the production boundary", () => {
    expect(() => createProductionCoreEngine({
      policy: {
        evaluate: async () => ({ effect: "allow" as const, reason: "untrusted" })
      }
    })).toThrow(/requires a ProcessIsolatedPolicyEngine/i);
  });

  it("accepts a process-isolated evaluator at the production boundary", () => {
    expect(() => createProductionCoreEngine({
      policy: new ProcessIsolatedPolicyEngine({ moduleUrl: fixtureUrl })
    })).not.toThrow();
  });
});
