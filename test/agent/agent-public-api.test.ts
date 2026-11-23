import { describe, expect, it } from "vitest";

describe("Agent package public API", () => {
  it("exposes the supported Agent entry point but blocks internal deep imports", () => {
    const agentEntry = new URL(import.meta.resolve("infinyx/agent"));
    expect(agentEntry.pathname.endsWith("/dist/agent/index.js")).toBe(true);

    let resolutionError: unknown;
    try {
      import.meta.resolve("infinyx/agent/agent-runtime.js");
    } catch (error) {
      resolutionError = error;
    }
    expect(resolutionError).toMatchObject({ code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
  });
});
