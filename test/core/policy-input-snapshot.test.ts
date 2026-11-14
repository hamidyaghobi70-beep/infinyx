import { describe, expect, it, vi } from "vitest";
import { snapshotBoundedPolicyData } from "../../src/core/policy-input-snapshot.js";

describe("snapshotBoundedPolicyData", () => {
  it("measures UTF-8 limits without invoking TextEncoder", () => {
    vi.stubGlobal("TextEncoder", class {
      constructor() { throw new Error("TextEncoder allocation must not occur."); }
    });
    try {
      expect(snapshotBoundedPolicyData({ value: "é".repeat(8_192) })).toBeDefined();
      expect(snapshotBoundedPolicyData({ value: "é".repeat(8_193) })).toBeUndefined();
      expect(snapshotBoundedPolicyData({ value: "a".repeat(16_384) })).toBeDefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("accepts a string at the per-string byte limit and rejects one byte over", () => {
    expect(snapshotBoundedPolicyData({ value: "a".repeat(16_384) })).toBeDefined();
    expect(snapshotBoundedPolicyData({ value: "a".repeat(16_385) })).toBeUndefined();
  });

  it("accepts the maximum supported depth and rejects deeper input", () => {
    let accepted: unknown = "leaf";
    for (let index = 0; index < 32; index += 1) accepted = { child: accepted };
    expect(snapshotBoundedPolicyData(accepted)).toBeDefined();

    const rejected = { child: accepted };
    expect(snapshotBoundedPolicyData(rejected)).toBeUndefined();
  });

  it("rejects excessive node counts and container entries", () => {
    expect(snapshotBoundedPolicyData(Array.from({ length: 1_001 }, () => 1))).toBeUndefined();
    const manyNodes = Array.from({ length: 10 }, () => Array.from({ length: 1_000 }, () => 1));
    expect(snapshotBoundedPolicyData(manyNodes)).toBeUndefined();
    expect(snapshotBoundedPolicyData({ values: ["a".repeat(16_000), "b".repeat(16_000)] })).toBeDefined();
    expect(snapshotBoundedPolicyData({ values: Array.from({ length: 17 }, () => "c".repeat(16_000)) })).toBeUndefined();
  });

  it("rejects cycles, accessors, sparse arrays, and non-finite numbers", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const accessor = Object.defineProperty({}, "secret", { enumerable: true, get: () => "value" });
    const sparse = new Array(2);
    expect(snapshotBoundedPolicyData(cyclic)).toBeUndefined();
    expect(snapshotBoundedPolicyData(accessor)).toBeUndefined();
    expect(snapshotBoundedPolicyData(sparse)).toBeUndefined();
    expect(snapshotBoundedPolicyData({ value: Number.NaN })).toBeUndefined();
  });

  it("returns a detached, deeply frozen snapshot", () => {
    const source = { nested: { values: ["before"] } };
    const snapshot = snapshotBoundedPolicyData(source);
    source.nested.values[0] = "after";
    expect(snapshot).toEqual({ nested: { values: ["before"] } });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot?.nested)).toBe(true);
    expect(Object.isFrozen(snapshot?.nested.values)).toBe(true);
  });

  it("documents that Proxy traps execute during same-process inspection", () => {
    const observed: string[] = [];
    const keys = Array.from({ length: 1_001 }, (_, index) => `k${index}`);
    const input = new Proxy({}, {
      getPrototypeOf(target) {
        observed.push("getPrototypeOf");
        return Reflect.getPrototypeOf(target);
      },
      ownKeys() {
        observed.push("ownKeys");
        return keys;
      }
    });

    expect(snapshotBoundedPolicyData(input)).toBeUndefined();
    expect(observed).toEqual(["getPrototypeOf", "ownKeys"]);
  });
});
