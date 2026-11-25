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
    const manyNodes = Array.from({ length: 10 }, (_, index) =>
      Array.from({ length: index === 9 ? 998 : 999 }, () => 1));
    expect(snapshotBoundedPolicyData(manyNodes)).toBeDefined();

    const overNodeLimit = Array.from({ length: 10 }, () => Array.from({ length: 999 }, () => 1));
    expect(snapshotBoundedPolicyData(overNodeLimit)).toBeUndefined();
    expect(snapshotBoundedPolicyData({ values: ["a".repeat(16_000), "b".repeat(16_000)] })).toBeDefined();
    expect(snapshotBoundedPolicyData({ values: Array.from({ length: 17 }, () => "c".repeat(16_000)) })).toBeUndefined();
  });

  it("accepts exactly the maximum number of own keys and rejects one over", () => {
    const atLimit: Record<string, number> = {};
    for (let index = 0; index < 1_000; index += 1) atLimit[`k${index}`] = index;
    const overLimit = { ...atLimit, extra: 1 };

    expect(snapshotBoundedPolicyData(atLimit)).toBeDefined();
    expect(snapshotBoundedPolicyData(overLimit)).toBeUndefined();
  });

  it("accepts the exact aggregate UTF-8 byte limit with multibyte strings and rejects one byte over", () => {
    // Each string is exactly 16 KiB in UTF-8 (8,192 two-byte characters).
    const atLimit = Array.from({ length: 16 }, () => "é".repeat(8_192));
    const overLimit = [...atLimit, "y"];

    expect(snapshotBoundedPolicyData(atLimit)).toBeDefined();
    expect(snapshotBoundedPolicyData(overLimit)).toBeUndefined();
  });

  it("enforces per-key and aggregate UTF-8 key byte limits", () => {
    const atPerKeyLimit = { ["k".repeat(16_384)]: true };
    const overPerKeyLimit = { ["k".repeat(16_385)]: true };
    expect(snapshotBoundedPolicyData(atPerKeyLimit)).toBeDefined();
    expect(snapshotBoundedPolicyData(overPerKeyLimit)).toBeUndefined();

    const exactAggregateKeys = [
      ...Array.from({ length: 15 }, () => "a".repeat(16_384)),
      "b".repeat(16_383),
      "c"
    ];
    const atAggregateLimit = Object.fromEntries(exactAggregateKeys.map((key, index) => [key, index]));
    const overAggregateLimit = { ...atAggregateLimit, d: 1 };
    expect(snapshotBoundedPolicyData(atAggregateLimit)).toBeDefined();
    expect(snapshotBoundedPolicyData(overAggregateLimit)).toBeUndefined();
  });

  it("counts object keys and numeric array index keys in the same aggregate UTF-8 budget", () => {
    const makeInput = (lastValueBytes: number) => ({
      array: Array.from({ length: 16 }, (_, index) =>
        "v".repeat(index === 15 ? lastValueBytes : 16_384))
    });

    // 15 * 16,384 + 16,357 value bytes, plus "array" and index keys
    // (5 + 22 bytes), totals exactly 256 KiB.
    expect(snapshotBoundedPolicyData(makeInput(16_357))).toBeDefined();
    expect(snapshotBoundedPolicyData(makeInput(16_358))).toBeUndefined();
  });

  it("rejects an oversized array before invoking a Proxy ownKeys trap", () => {
    const observed: string[] = [];
    const input = new Proxy(new Array(1_001), {
      getOwnPropertyDescriptor(target, key) {
        if (key === "length") observed.push("descriptor:length");
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      ownKeys(target) {
        observed.push("ownKeys");
        return Reflect.ownKeys(target);
      }
    });

    expect(snapshotBoundedPolicyData(input)).toBeUndefined();
    expect(observed).toContain("descriptor:length");
    expect(observed).not.toContain("ownKeys");
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

  it("does not execute a getter when rejecting accessor properties", () => {
    let getterCalls = 0;
    const input = Object.defineProperty({}, "secret", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "value";
      }
    });

    expect(snapshotBoundedPolicyData(input)).toBeUndefined();
    expect(getterCalls).toBe(0);
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

  it("documents that own-key enumeration completes before returned-key limits can be checked for Proxies", () => {
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

  it("reads array length from its descriptor without invoking the Proxy get trap", () => {
    const observed: string[] = [];
    const input = new Proxy([1], {
      get(target, key, receiver) {
        if (key === "length") observed.push("get:length");
        return Reflect.get(target, key, receiver);
      },
      getOwnPropertyDescriptor(target, key) {
        if (key === "length") observed.push("descriptor:length");
        return Reflect.getOwnPropertyDescriptor(target, key);
      }
    });

    expect(snapshotBoundedPolicyData(input)).toEqual([1]);
    expect(observed).toContain("descriptor:length");
    expect(observed).not.toContain("get:length");
  });

  it("documents that property-descriptor reflection also executes Proxy traps", () => {
    const observed: string[] = [];
    const target = { value: 1 };
    const input = new Proxy(target, {
      getPrototypeOf(object) {
        observed.push("getPrototypeOf");
        return Reflect.getPrototypeOf(object);
      },
      ownKeys(object) {
        observed.push("ownKeys");
        return Reflect.ownKeys(object);
      },
      getOwnPropertyDescriptor(object, key) {
        observed.push(`getOwnPropertyDescriptor:${String(key)}`);
        return Reflect.getOwnPropertyDescriptor(object, key);
      }
    });

    expect(snapshotBoundedPolicyData(input)).toEqual({ value: 1 });
    expect(observed).toEqual(["getPrototypeOf", "ownKeys", "getOwnPropertyDescriptor:value"]);
  });
});
