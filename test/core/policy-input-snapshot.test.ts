import { describe, expect, it } from "vitest";
import { snapshotBoundedPolicyData } from "../../src/core/policy-input-snapshot.js";

describe("snapshotBoundedPolicyData", () => {
  it("preserves valid undefined without confusing it with failure", () => {
    expect(snapshotBoundedPolicyData(undefined)).toEqual({ ok: true, value: undefined });
  });

  it("returns a detached, deeply frozen snapshot", () => {
    const source = { nested: { values: ["before"] } };
    const result = snapshotBoundedPolicyData(source);
    source.nested.values[0] = "after";

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ nested: { values: ["before"] } });
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.nested)).toBe(true);
    expect(Object.isFrozen(result.value.nested.values)).toBe(true);
  });

  it("accepts a string at the per-string UTF-8 byte limit and rejects one byte over", () => {
    expect(snapshotBoundedPolicyData("a".repeat(16_384)).ok).toBe(true);
    expect(snapshotBoundedPolicyData("a".repeat(16_385))).toEqual({
      ok: false, reason: "RESOURCE_LIMIT"
    });
  });

  it("counts UTF-8 bytes rather than JavaScript UTF-16 code units", () => {
    expect(snapshotBoundedPolicyData("é".repeat(8_192)).ok).toBe(true);
    expect(snapshotBoundedPolicyData("é".repeat(8_193))).toEqual({
      ok: false, reason: "RESOURCE_LIMIT"
    });
  });

  it("accepts the maximum supported depth and rejects one level deeper", () => {
    let accepted: unknown = "leaf";
    for (let index = 0; index < 32; index += 1) accepted = { child: accepted };
    expect(snapshotBoundedPolicyData(accepted).ok).toBe(true);
    expect(snapshotBoundedPolicyData({ child: accepted })).toEqual({
      ok: false, reason: "RESOURCE_LIMIT"
    });
  });

  it("accepts exactly the maximum node count and rejects one additional node", () => {
    const groups = Array.from({ length: 10 }, () => Array.from({ length: 998 }, () => 0));
    const atLimit = Object.assign({ groups }, {
      a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, g: 0, h: 0
    });
    expect(snapshotBoundedPolicyData(atLimit).ok).toBe(true);
    expect(snapshotBoundedPolicyData({ ...atLimit, i: 0 })).toEqual({
      ok: false, reason: "RESOURCE_LIMIT"
    });
  });

  it("accepts exactly the aggregate byte limit and rejects one byte over", () => {
    const atLimit = Array.from({ length: 16 }, () => "x".repeat(16_384));
    expect(snapshotBoundedPolicyData(atLimit).ok).toBe(true);
    expect(snapshotBoundedPolicyData([...atLimit, "x"])).toEqual({
      ok: false, reason: "RESOURCE_LIMIT"
    });
  });

  it("enforces the maximum number of entries in each container", () => {
    expect(snapshotBoundedPolicyData(Array.from({ length: 1_000 }, () => 1)).ok).toBe(true);
    expect(snapshotBoundedPolicyData(Array.from({ length: 1_001 }, () => 1))).toEqual({
      ok: false, reason: "RESOURCE_LIMIT"
    });
    const record = Object.fromEntries(Array.from({ length: 1_001 }, (_, index) => [`k${index}`, 1]));
    expect(snapshotBoundedPolicyData(record)).toEqual({
      ok: false, reason: "RESOURCE_LIMIT"
    });
  });

  it("rejects cycles but safely duplicates repeated non-cyclic references", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(snapshotBoundedPolicyData(cyclic)).toEqual({
      ok: false, reason: "CIRCULAR_REFERENCE"
    });

    const shared = { value: 1 };
    const result = snapshotBoundedPolicyData({ left: shared, right: shared });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.left).not.toBe(result.value.right);
  });

  it("rejects accessors without invoking their getter", () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "secret", {
      enumerable: true,
      get: () => { getterCalls += 1; return "value"; }
    });
    expect(snapshotBoundedPolicyData(accessor)).toEqual({
      ok: false, reason: "ACCESSOR_PROPERTY"
    });
    expect(getterCalls).toBe(0);
  });

  it("rejects hidden properties", () => {
    const hidden = Object.defineProperty({}, "secret", {
      enumerable: false, value: "value"
    });
    expect(snapshotBoundedPolicyData(hidden)).toEqual({
      ok: false, reason: "ACCESSOR_PROPERTY"
    });
  });

  it("rejects sparse arrays and arrays with custom properties", () => {
    expect(snapshotBoundedPolicyData(new Array(2))).toEqual({
      ok: false, reason: "RESOURCE_LIMIT"
    });
    const custom = [1] as number[] & { extra?: number };
    custom.extra = 2;
    expect(snapshotBoundedPolicyData(custom)).toEqual({
      ok: false, reason: "INVALID_STRUCTURE"
    });
  });

  it("rejects symbol keys and unsupported values", () => {
    expect(snapshotBoundedPolicyData({ [Symbol("secret")]: 1 })).toEqual({
      ok: false, reason: "INVALID_STRUCTURE"
    });
    expect(snapshotBoundedPolicyData({ value: Number.NaN })).toEqual({
      ok: false, reason: "UNSUPPORTED_VALUE"
    });
    expect(snapshotBoundedPolicyData({ value: Number.POSITIVE_INFINITY })).toEqual({
      ok: false, reason: "UNSUPPORTED_VALUE"
    });
    expect(snapshotBoundedPolicyData({ value: 1n })).toEqual({
      ok: false, reason: "UNSUPPORTED_VALUE"
    });
    expect(snapshotBoundedPolicyData({ value: () => "x" })).toEqual({
      ok: false, reason: "UNSUPPORTED_VALUE"
    });
  });

  it("supports null-prototype records and preserves an own __proto__ data property", () => {
    const source = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(source, "__proto__", {
      configurable: true, enumerable: true, writable: true, value: { safe: true }
    });
    const result = snapshotBoundedPolicyData(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.getPrototypeOf(result.value)).toBe(null);
    expect(Object.hasOwn(result.value, "__proto__")).toBe(true);
    expect(result.value.__proto__).toEqual({ safe: true });
  });

  it("rejects non-plain objects", () => {
    expect(snapshotBoundedPolicyData(new Date())).toEqual({
      ok: false, reason: "UNSUPPORTED_VALUE"
    });
    expect(snapshotBoundedPolicyData(new Map())).toEqual({
      ok: false, reason: "UNSUPPORTED_VALUE"
    });
  });

  it("does not expose exceptions thrown by reflective input objects", () => {
    const hostile = new Proxy({}, {
      ownKeys() { throw new Error("sensitive proxy trap detail"); }
    });
    expect(snapshotBoundedPolicyData(hostile)).toEqual({
      ok: false, reason: "INVALID_STRUCTURE"
    });
  });
});
