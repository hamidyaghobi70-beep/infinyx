import { describe, expect, it } from "vitest";
import type { CoreModule, ModuleContext } from "../../src/core/contracts.js";
import { CoreError } from "../../src/core/core-error.js";
import { ModuleRegistry } from "../../src/core/module-registry.js";

describe("ModuleRegistry", () => {
  it("resolves dependencies before dependants", () => {
    const registry = new ModuleRegistry();
    registry.register({ id: "api", version: "1.0.0", dependencies: ["platform"] });
    registry.register({ id: "platform", version: "1.0.0" });

    expect(registry.resolveStartOrder().map((module) => module.id)).toEqual(["platform", "api"]);
  });

  it("rejects duplicate module identifiers", () => {
    const registry = new ModuleRegistry();
    registry.register({ id: "platform", version: "1.0.0" });

    expect(() => registry.register({ id: "platform", version: "1.0.1" }))
      .toThrowError(CoreError);
  });

  it("rejects missing dependencies and dependency cycles", () => {
    const missing = new ModuleRegistry();
    missing.register({ id: "api", version: "1.0.0", dependencies: ["missing"] });
    expect(() => missing.resolveStartOrder()).toThrowError(/not registered/);

    const cyclic = new ModuleRegistry();
    cyclic.register({ id: "alpha", version: "1.0.0", dependencies: ["beta"] });
    cyclic.register({ id: "beta", version: "1.0.0", dependencies: ["alpha"] });
    expect(() => cyclic.resolveStartOrder()).toThrowError(/dependency cycle/i);
  });

  it("preserves prototype lifecycle hooks and their instance context", async () => {
    class StatefulModule implements CoreModule {
      readonly id = "stateful";
      readonly version = "1.0.0";
      initializedBy: string | undefined;

      initialize() {
        this.initializedBy = this.id;
      }
    }

    const registry = new ModuleRegistry();
    const source = new StatefulModule();
    registry.register(source);

    const registered = registry.get("stateful");
    expect(registered).toBeDefined();
    await registered?.initialize?.({} as ModuleContext);

    expect(source.initializedBy).toBe("stateful");
    expect(registered?.initialize).toBeTypeOf("function");
  });
});
