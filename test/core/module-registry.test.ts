import { describe, expect, it } from "vitest";
import type { CoreModule } from "../../src/core/contracts.js";
import { CoreEngine } from "../../src/core/core-engine.js";
import { CoreError } from "../../src/core/core-error.js";
import { MAX_CORE_MODULES, MAX_MODULE_DEPENDENCIES, MAX_TOTAL_MODULE_DEPENDENCIES, ModuleRegistry } from "../../src/core/module-registry.js";

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

  it("detects an indirect dependency cycle and reports the cycle path", () => {
    const registry = new ModuleRegistry();
    registry.register({ id: "alpha", version: "1.0.0", dependencies: ["beta"] });
    registry.register({ id: "beta", version: "1.0.0", dependencies: ["gamma"] });
    registry.register({ id: "gamma", version: "1.0.0", dependencies: ["alpha"] });

    expect(() => registry.resolveStartOrder()).toThrowError(/alpha -> beta -> gamma -> alpha/);
  });

  it("resolves a dependency chain at the maximum supported module count", () => {
    const registry = new ModuleRegistry();
    for (let index = 0; index < MAX_CORE_MODULES; index += 1) {
      registry.register({
        id: "chain-" + index,
        version: "1.0.0",
        ...(index + 1 < MAX_CORE_MODULES
          ? { dependencies: ["chain-" + (index + 1)] }
          : {})
      });
    }

    const order = registry.resolveStartOrder().map((module) => module.id);
    expect(order).toHaveLength(MAX_CORE_MODULES);
    expect(order[0]).toBe("chain-" + (MAX_CORE_MODULES - 1));
    expect(order[MAX_CORE_MODULES - 1]).toBe("chain-0");
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

  it("does not invoke a caller-controlled bind getter on lifecycle hooks", async () => {
    const registry = new ModuleRegistry();
    let bindGetterCalls = 0;
    let hookCalls = 0;
    const hook = function () { hookCalls += 1; };
    Object.defineProperty(hook, "bind", {
      configurable: true,
      get() {
        bindGetterCalls += 1;
        throw new Error("hostile bind getter");
      }
    });

    registry.register({
      id: "hostile-bind",
      version: "1.0.0",
      stop: hook as CoreModule["stop"]
    });

    expect(bindGetterCalls).toBe(0);
    await registry.get("hostile-bind")?.stop?.({} as never);
    expect(bindGetterCalls).toBe(0);
    expect(hookCalls).toBe(1);
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

  it("rejects dependency identifiers that exceed the module identifier contract", () => {
    const registry = new ModuleRegistry();

    expect(() => registry.register({
      id: "oversized-dependency",
      version: "1.0.0",
      dependencies: ["a".repeat(129)]
    })).toThrowError(CoreError);

    expect(() => registry.register({
      id: "malformed-dependency",
      version: "1.0.0",
      dependencies: ["Invalid_Dependency"]
    })).toThrowError(CoreError);

    expect(registry.list()).toHaveLength(0);
  });

  it("enforces a total dependency-edge budget across the registry", async () => {
    const registry = new ModuleRegistry();
    const perModule = MAX_MODULE_DEPENDENCIES;
    const fullLists = Math.floor(MAX_TOTAL_MODULE_DEPENDENCIES / perModule);
    for (let index = 0; index < fullLists; index += 1) {
      registry.register({
        id: "edge-module-" + index,
        version: "1.0.0",
        dependencies: Array.from(
          { length: perModule },
          (_, dependencyIndex) => "dependency-" + dependencyIndex
        )
      });
    }

    expect(() => registry.register({
      id: "edge-module-overflow",
      version: "1.0.0",
      dependencies: ["one"]
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

