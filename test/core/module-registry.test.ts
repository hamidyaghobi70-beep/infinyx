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
});


describe("ModuleRegistry trust-boundary snapshots", () => {
  it("rejects accessor metadata without invoking its getter", () => {
    const registry = new ModuleRegistry();
    let getterCalls = 0;
    const module = {
      version: "1.0.0",
      get id() {
        getterCalls += 1;
        return "hostile";
      }
    } as unknown as CoreModule;

    expect(() => registry.register(module)).toThrowError(CoreError);
    expect(getterCalls).toBe(0);
    expect(registry.list()).toHaveLength(0);
  });

  it("rejects accessor lifecycle hooks without invoking them", () => {
    const registry = new ModuleRegistry();
    let getterCalls = 0;
    const module = {
      id: "hostile-hook",
      version: "1.0.0",
      get stop() {
        getterCalls += 1;
        return () => undefined;
      }
    } as unknown as CoreModule;

    expect(() => registry.register(module)).toThrowError(CoreError);
    expect(getterCalls).toBe(0);
  });

  it("snapshots dependency array entries and rejects accessor elements", () => {
    const registry = new ModuleRegistry();
    const dependencies = ["platform"];
    registry.register({
      id: "api",
      version: "1.0.0",
      dependencies
    });
    dependencies[0] = "changed";

    registry.register({ id: "platform", version: "1.0.0" });
    expect(registry.resolveStartOrder().map((module) => module.id))
      .toEqual(["platform", "api"]);

    let elementGetterCalls = 0;
    const hostileDependencies = ["platform"];
    Object.defineProperty(hostileDependencies, "0", {
      configurable: true,
      enumerable: true,
      get() {
        elementGetterCalls += 1;
        return "platform";
      }
    });
    expect(() => registry.register({
      id: "hostile-deps",
      version: "1.0.0",
      dependencies: hostileDependencies
    })).toThrowError(CoreError);
    expect(elementGetterCalls).toBe(0);
  });

  it("converts throwing Proxy reflection traps into a registration error", () => {
    const registry = new ModuleRegistry();
    const hostile = new Proxy(
      { id: "proxy-module", version: "1.0.0" } as CoreModule,
      {
        getOwnPropertyDescriptor() {
          throw new Error("reflection trap");
        }
      }
    );

    expect(() => registry.register(hostile)).toThrowError(CoreError);
    expect(registry.list()).toHaveLength(0);
  });

  it("captures a lifecycle hook descriptor only once", async () => {
    const registry = new ModuleRegistry();
    let descriptorReads = 0;
    let calls = 0;
    const first = () => { calls += 1; };
    const second = () => { calls += 100; };
    const target = {
      id: "changing-hook",
      version: "1.0.0",
      stop: first
    } as CoreModule;
    const module = new Proxy(target, {
      getOwnPropertyDescriptor(object, key) {
        if (key === "stop") {
          descriptorReads += 1;
          return {
            configurable: true,
            enumerable: true,
            writable: true,
            value: descriptorReads === 1 ? first : second
          };
        }
        return Reflect.getOwnPropertyDescriptor(object, key);
      }
    });

    registry.register(module);
    await registry.get("changing-hook")?.stop?.({} as never);
    expect(descriptorReads).toBe(1);
    expect(calls).toBe(1);
  });
});


describe("ModuleRegistry resource bounds", () => {
  it("rejects registration beyond the global module limit", async () => {
    const { MAX_CORE_MODULES } = await import("../../src/core/module-registry.js");
    const registry = new ModuleRegistry();
    for (let index = 0; index < MAX_CORE_MODULES; index += 1) {
      registry.register({
        id: "module-" + index,
        version: "1.0.0"
      });
    }

    expect(() => registry.register({
      id: "module-over-limit",
      version: "1.0.0"
    })).toThrowError(CoreError);
    expect(registry.list()).toHaveLength(MAX_CORE_MODULES);
  });

  it("rejects oversized and duplicate dependency lists", () => {
    const { MAX_MODULE_DEPENDENCIES } = requireModuleLimitsForTest();
    const registry = new ModuleRegistry();
    const tooMany = Array.from(
      { length: MAX_MODULE_DEPENDENCIES + 1 },
      (_, index) => "dependency-" + index
    );

    expect(() => registry.register({
      id: "oversized",
      version: "1.0.0",
      dependencies: tooMany
    })).toThrowError(CoreError);

    expect(() => registry.register({
      id: "duplicates",
      version: "1.0.0",
      dependencies: ["base", "base"]
    })).toThrowError(CoreError);
  });

  it("does not reread caller-controlled module properties after snapshotting", () => {
    const engine = new CoreEngine();
    const target = { id: "stable-module", version: "1.0.0" } as CoreModule;
    const hostile = new Proxy(target, {
      get() {
        throw new Error("untrusted property read");
      }
    });

    expect(() => engine.register(hostile)).not.toThrow();
    expect(engine.getModules().map((module) => module.id)).toEqual(["stable-module"]);
    expect(engine.getModuleStates().get("stable-module")).toBe("registered");
  });
});

function requireModuleLimitsForTest(): {
  MAX_MODULE_DEPENDENCIES: number;
} {
  // Kept synchronous so this test can assert the registration boundary directly.
  return { MAX_MODULE_DEPENDENCIES: 64 };
}
