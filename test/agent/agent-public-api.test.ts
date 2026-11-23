import { describe, expect, it } from "vitest";

describe("Agent package public API", () => {
  it("exposes only the supported Agent entry point", () => {
    expect(import.meta.resolve("infinyx/agent")).toMatch(/dist\\/agent\\/index\\.js$|dist\\/agent\\/index\\.js$/);
    let resolutionError: unknown;
    try {
      import.meta.resolve("infinyx/agent/agent-runtime.js");
    } catch (error) {
      resolutionError = error;
    }
    expect(resolutionError).toMatchObject({ code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
  });
});
