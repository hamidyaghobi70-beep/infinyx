import { describe, expect, it } from "vitest";
import type { CoreModule } from "../../src/core/contracts.js";
import { CoreEngine } from "../../src/core/core-engine.js";
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
      readonly calls: string[] = [];

      initialize() {
        this.calls.push("initialize:" + this.id);
      }

      start() {
        this.calls.push("start:" + this.id);
      }

      stop() {
        this.calls.push("stop:" + this.id);
      }
    }

    const engine = new CoreEngine();
    const source = new StatefulModule();
    engine.register(source);

    await engine.initialize();
    await engine.start();
    await engine.stop();

    expect(source.calls).toEqual([
      "initialize:stateful",
      "start:stateful",
      "stop:stateful"
    ]);
  });

  it("snapshots accessor-backed module metadata exactly once", () => {
    const registry = new ModuleRegistry();
    let idReads = 0;
    let versionReads = 0;
    let dependencyReads = 0;
    const module = {
      get id() { idReads += 1; return idReads === 1 ? "stable" : "invalid"; },
      get version() { versionReads += 1; return versionReads === 1 ? "1.0.0" : ""; },
      get dependencies() { dependencyReads += 1; return []; }
    } as unknown as CoreModule;

    registry.register(module);

    expect(idReads).toBe(1);
    expect(versionReads).toBe(1);
    expect(dependencyReads).toBe(1);
    expect(registry.get("stable")?.id).toBe("stable");
    expect(registry.get("invalid")).toBeUndefined();
  });

  it("rejects malformed runtime dependency collections and lifecycle hooks", () => {
    const registry = new ModuleRegistry();

    expect(() => registry.register({
      id: "bad-dependencies", version: "1.0.0", dependencies: "platform" as unknown as readonly string[]
    })).toThrowError(CoreError);
    expect(() => registry.register({
      id: "bad-hook", version: "1.0.0", initialize: 42 as unknown as () => void
    })).toThrowError(CoreError);
  });
  it("snapshots dependency data descriptors without invoking accessors", () => {
    const registry = new ModuleRegistry();
    let getterCalls = 0;
    const dependencies: string[] = [];
    Object.defineProperty(dependencies, "0", {
      enumerable: true,
      configurable: true,
      get: () => { getterCalls += 1; return "platform"; }
    });
    dependencies.length = 1;

    expect(() => registry.register({
      id: "api", version: "1.0.0", dependencies
    })).toThrowError(CoreError);
    expect(getterCalls).toBe(0);
    expect(registry.list()).toHaveLength(0);
  });

  it("rejects sparse dependency arrays and snapshots later mutations", () => {
    const sparseRegistry = new ModuleRegistry();
    const sparse = new Array<string>(1);
    expect(() => sparseRegistry.register({
      id: "sparse-api", version: "1.0.0", dependencies: sparse
    })).toThrowError(CoreError);

    const registry = new ModuleRegistry();
    const dependencies = ["platform"];
    registry.register({ id: "api", version: "1.0.0", dependencies });
    dependencies[0] = "missing";
    registry.register({ id: "platform", version: "1.0.0" });

    expect(registry.resolveStartOrder().map((module) => module.id)).toEqual(["platform", "api"]);
  });

});


describe("ModuleRegistry hostile prototype boundary", () => {
  it("rejects a cyclic Proxy prototype chain while capturing lifecycle hooks", () => {
    const registry = new ModuleRegistry();
    const target = { id: "cyclic-prototype", version: "1.0.0" } as CoreModule;
    let cyclic!: CoreModule;
    cyclic = new Proxy(target, {
      getPrototypeOf() {
        return cyclic;
      }
    });

    expect(() => registry.register(cyclic)).toThrowError(CoreError);
    expect(registry.list()).toHaveLength(0);
  });
});
