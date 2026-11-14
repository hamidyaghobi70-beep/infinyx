import { describe, expect, it } from "vitest";
import { snapshotBoundedPolicyData } from "../../src/core/policy-input-snapshot.js";

describe("snapshotBoundedPolicyData", () => {
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
    expect(snapshotBoundedPolicyData(Array.from({ length: 10_001 }, () => 1))).toBeUndefined();
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
});
