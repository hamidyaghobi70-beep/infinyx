import { describe, expect, it } from "vitest";
import { createProductionCoreEngine } from "../../src/core/production-core-engine.js";
import { ProcessIsolatedPolicyEngine } from "../../src/core/process-isolated-policy-engine.js";

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
    })).toThrow(/custom policy evaluators are disabled/i);
  });

  it("also rejects a child-process evaluator until process-tree supervision is implemented", () => {
    const isolated = new ProcessIsolatedPolicyEngine({
      moduleUrl: new URL("../fixtures/policy-evaluator-fixture.mjs", import.meta.url).href
    });

    expect(() => createProductionCoreEngine({ policy: isolated }))
      .toThrow(/verified OS-level process-tree supervision/i);
  });
});
