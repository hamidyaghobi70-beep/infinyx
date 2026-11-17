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

  it("captures changing lifecycle hook descriptors only once", async () => {
    const registry = new ModuleRegistry();
    let reads = 0;
    const first = () => { reads += 1; };
    const second = () => { reads += 100; };
    const module = {
      id: "changing-hook",
      version: "1.0.0"
    } as CoreModule;
    Object.defineProperty(module, "stop", {
      configurable: true,
      get: undefined,
      value: first
    });

    registry.register(module);
    const registered = registry.get("changing-hook");
    await registered?.stop?.({} as never);
    expect(reads).toBe(1);
  });
});
