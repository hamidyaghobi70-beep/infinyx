import { describe, expect, it, vi } from "vitest";
import { snapshotBoundedPolicyData } from "../../src/core/policy-input-snapshot.js";

describe("snapshotBoundedPolicyData", () => {
  it("measures UTF-8 limits without invoking TextEncoder", () => {
    vi.stubGlobal("TextEncoder", class {
      constructor() { throw new Error("TextEncoder allocation must not occur."); }
    });
    try {
      expect(snapshotBoundedPolicyData({ value: "é".repeat(8_192) })).toMatchObject({ ok: true });
      expect(snapshotBoundedPolicyData({ value: "é".repeat(8_193) })).toEqual({ ok: false });
      expect(snapshotBoundedPolicyData({ value: "a".repeat(16_384) })).toMatchObject({ ok: true });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("accepts a string at the per-string byte limit and rejects one byte over", () => {
    expect(snapshotBoundedPolicyData({ value: "a".repeat(16_384) })).toMatchObject({ ok: true });
    expect(snapshotBoundedPolicyData({ value: "a".repeat(16_385) })).toEqual({ ok: false });
  });

  it("accepts the maximum supported depth and rejects deeper input", () => {
    let accepted: unknown = "leaf";
    for (let index = 0; index < 32; index += 1) accepted = { child: accepted };
    expect(snapshotBoundedPolicyData(accepted)).toMatchObject({ ok: true });

    const rejected = { child: accepted };
    expect(snapshotBoundedPolicyData(rejected)).toEqual({ ok: false });
  });

  it("rejects excessive node counts and container entries", () => {
    expect(snapshotBoundedPolicyData(Array.from({ length: 1_001 }, () => 1))).toEqual({ ok: false });
    const manyNodes = Array.from({ length: 10 }, (_, index) =>
      Array.from({ length: index === 9 ? 998 : 999 }, () => 1));
    expect(snapshotBoundedPolicyData(manyNodes)).toMatchObject({ ok: true });

    const overNodeLimit = Array.from({ length: 10 }, () => Array.from({ length: 999 }, () => 1));
    expect(snapshotBoundedPolicyData(overNodeLimit)).toEqual({ ok: false });
    expect(snapshotBoundedPolicyData({ values: ["a".repeat(16_000), "b".repeat(16_000)] })).toMatchObject({ ok: true });
    expect(snapshotBoundedPolicyData({ values: Array.from({ length: 17 }, () => "c".repeat(16_000)) })).toEqual({ ok: false });
  });

  it("accepts exactly the maximum number of own keys and rejects one over", () => {
    const atLimit: Record<string, number> = {};
    for (let index = 0; index < 1_000; index += 1) atLimit[`k${index}`] = index;
    const overLimit = { ...atLimit, extra: 1 };

    expect(snapshotBoundedPolicyData(atLimit)).toMatchObject({ ok: true });
    expect(snapshotBoundedPolicyData(overLimit)).toEqual({ ok: false });
  });

  it("accepts the exact aggregate UTF-8 byte limit with multibyte strings and rejects one byte over", () => {
    // The first 15 values use 16 KiB each. The final value leaves room for
    // the UTF-8 bytes of array index keys (0..15) in the shared budget.
    const atLimit = Array.from({ length: 16 }, (_, index) =>
      "é".repeat(index === 15 ? 8_181 : 8_192));
    const overLimit = Array.from({ length: 16 }, (_, index) =>
      index === 15 ? `${"é".repeat(8_181)}x` : "é".repeat(8_192));

    expect(snapshotBoundedPolicyData(atLimit)).toMatchObject({ ok: true });
    expect(snapshotBoundedPolicyData(overLimit)).toEqual({ ok: false });
  });

  it("enforces per-key and aggregate UTF-8 key byte limits", () => {
    const atPerKeyLimit = { ["k".repeat(16_384)]: true };
    const overPerKeyLimit = { ["k".repeat(16_385)]: true };
    expect(snapshotBoundedPolicyData(atPerKeyLimit)).toMatchObject({ ok: true });
    expect(snapshotBoundedPolicyData(overPerKeyLimit)).toEqual({ ok: false });

    // Use distinct keys: Object.fromEntries would otherwise collapse
    // duplicate strings and fail to exercise the aggregate key budget.
    const exactAggregateKeys = Array.from({ length: 16 }, (_, index) => {
      const prefix = `key${index}:`;
      return prefix + "a".repeat(16_384 - prefix.length);
    });
    const atAggregateLimit = Object.fromEntries(exactAggregateKeys.map((key, index) => [key, index]));
    const overAggregateLimit = Object.fromEntries([
      ...exactAggregateKeys.map((key, index) => [key, index] as const),
      ["z", true] as const
    ]);
    expect(new Set(exactAggregateKeys).size).toBe(16);
    expect(snapshotBoundedPolicyData(atAggregateLimit)).toMatchObject({ ok: true });
    expect(snapshotBoundedPolicyData(overAggregateLimit)).toEqual({ ok: false });
  });

  it("counts object keys and numeric array index keys in the same aggregate UTF-8 budget", () => {
    const makeInput = (lastValueBytes: number) => ({
      array: Array.from({ length: 16 }, (_, index) =>
        "v".repeat(index === 15 ? lastValueBytes : 16_384))
    });

    // 15 * 16,384 + 16,357 value bytes, plus "array" and index keys
    // (5 + 22 bytes), totals exactly 256 KiB.
    expect(snapshotBoundedPolicyData(makeInput(16_357))).toMatchObject({ ok: true });
    expect(snapshotBoundedPolicyData(makeInput(16_358))).toEqual({ ok: false });
  });

  it("rejects an oversized array Proxy before invoking any reflection trap", () => {
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

    expect(snapshotBoundedPolicyData(input)).toEqual({ ok: false });
    expect(observed).toEqual([]);
  });

  it("rejects cycles, accessors, sparse arrays, and non-finite numbers", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const accessor = Object.defineProperty({}, "secret", { enumerable: true, get: () => "value" });
    const sparse = new Array(2);
    expect(snapshotBoundedPolicyData(cyclic)).toEqual({ ok: false });
    expect(snapshotBoundedPolicyData(accessor)).toEqual({ ok: false });
    expect(snapshotBoundedPolicyData(sparse)).toEqual({ ok: false });
    expect(snapshotBoundedPolicyData({ value: Number.NaN })).toEqual({ ok: false });
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

    expect(snapshotBoundedPolicyData(input)).toEqual({ ok: false });
    expect(getterCalls).toBe(0);
  });

  it("returns a detached, deeply frozen snapshot", () => {
    const source = { nested: { values: ["before"] } };
    const result = snapshotBoundedPolicyData(source);
    source.nested.values[0] = "after";
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected a valid snapshot.");
    const snapshot = result.value;
    expect(snapshot).toEqual({ nested: { values: ["before"] } });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.nested)).toBe(true);
    expect(Object.isFrozen(snapshot.nested.values)).toBe(true);
  });

  it("preserves valid falsy primitive values in the success result", () => {
    expect(snapshotBoundedPolicyData(undefined)).toEqual({ ok: true, value: undefined });
    expect(snapshotBoundedPolicyData(false)).toEqual({ ok: true, value: false });
    expect(snapshotBoundedPolicyData(0)).toEqual({ ok: true, value: 0 });
    expect(snapshotBoundedPolicyData("")).toEqual({ ok: true, value: "" });
  });

  it("snapshots ordinary arrays using their own length descriptor", () => {
    expect(snapshotBoundedPolicyData([1, 2, 3])).toEqual({ ok: true, value: [1, 2, 3] });
  });

  it("rejects root Proxies before invoking any reflection traps", () => {
    const observed: string[] = [];
    const input = new Proxy({ value: 1 }, {
      getPrototypeOf(target) {
        observed.push("getPrototypeOf");
        return Reflect.getPrototypeOf(target);
      },
      ownKeys(target) {
        observed.push("ownKeys");
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(target, key) {
        observed.push(`getOwnPropertyDescriptor:${String(key)}`);
        return Reflect.getOwnPropertyDescriptor(target, key);
      }
    });

    expect(snapshotBoundedPolicyData(input)).toEqual({ ok: false });
    expect(observed).toEqual([]);
  });

  it("rejects nested Proxies before reflecting on the nested value", () => {
    const observed: string[] = [];
    const nested = new Proxy({ value: 1 }, {
      getPrototypeOf(target) {
        observed.push("getPrototypeOf");
        return Reflect.getPrototypeOf(target);
      },
      ownKeys(target) {
        observed.push("ownKeys");
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(target, key) {
        observed.push(`getOwnPropertyDescriptor:${String(key)}`);
        return Reflect.getOwnPropertyDescriptor(target, key);
      }
    });

    expect(snapshotBoundedPolicyData({ nested })).toEqual({ ok: false });
    expect(observed).toEqual([]);
  });

  it("rejects array Proxies before trusting a trap-reported length", () => {
    const observed: string[] = [];
    const input = new Proxy(new Array(1_001), {
      getPrototypeOf(target) {
        observed.push("getPrototypeOf");
        return Reflect.getPrototypeOf(target);
      },
      getOwnPropertyDescriptor(target, key) {
        observed.push(`getOwnPropertyDescriptor:${String(key)}`);
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        if (key === "length" && descriptor) return { ...descriptor, value: 1 };
        return descriptor;
      },
      ownKeys(target) {
        observed.push("ownKeys");
        return Reflect.ownKeys(target);
      }
    });

    expect(snapshotBoundedPolicyData(input)).toEqual({ ok: false });
    expect(observed).toEqual([]);
  });

  it("rejects revoked Proxies without invoking their traps", () => {
    const revocable = Proxy.revocable({ value: 1 }, {});
    revocable.revoke();

    expect(snapshotBoundedPolicyData(revocable.proxy)).toEqual({ ok: false });
  });

});
