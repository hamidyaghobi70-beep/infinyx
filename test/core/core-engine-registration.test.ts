import { describe, expect, it } from "vitest";
import type { CoreModule } from "../../src/core/contracts.js";
import { CoreEngine } from "../../src/core/core-engine.js";

describe("CoreEngine module registration identity", () => {
  it("uses the registry's captured id without rereading caller-controlled metadata", () => {
    const engine = new CoreEngine();
    let idReads = 0;
    const module = {
      get id() {
        idReads += 1;
        return idReads === 1 ? "stable-module" : "changed-module";
      },
      version: "1.0.0"
    } as unknown as CoreModule;

    engine.register(module);

    expect(idReads).toBe(1);
    expect(engine.getModules().map((registered) => registered.id)).toEqual(["stable-module"]);
    expect([...engine.getModuleStates().entries()]).toEqual([["stable-module", "registered"]]);
  });

  it("does not leave a registered module behind when its id getter would fail on a second read", () => {
    const engine = new CoreEngine();
    let idReads = 0;
    const module = {
      get id() {
        idReads += 1;
        if (idReads > 1) throw new Error("id read more than once");
        return "single-read-module";
      },
      version: "1.0.0"
    } as unknown as CoreModule;

    expect(() => engine.register(module)).not.toThrow();
    expect(idReads).toBe(1);
    expect(engine.getModules().map((registered) => registered.id)).toEqual(["single-read-module"]);
    expect(engine.getModuleStates().get("single-read-module")).toBe("registered");
  });
});
