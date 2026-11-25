import { describe, expect, it } from "vitest";
import { parseBoundedPolicyJson } from "../../src/core/policy-input-json-parser.js";

describe("parseBoundedPolicyJson", () => {
  it("parses into detached frozen plain data", () => {
    const result = parseBoundedPolicyJson('{"actorId":"a","context":{"attributes":{"ok":true}}}');
    expect(result).toEqual({ actorId: "a", context: { attributes: { ok: true } } });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.getPrototypeOf(result)).toBeNull();
  });
  it("accepts exactly 512 KiB of raw UTF-8 input and rejects one byte over", () => {
    expect(parseBoundedPolicyJson("null".padEnd(524_288, " "))).toBeNull();
    expect(parseBoundedPolicyJson("null".padEnd(524_289, " "))).toBeUndefined();
  });
  it("rejects excessive object keys and accepts the exact entry boundary", () => {
    const pairs = (n: number) => Array.from({ length: n }, (_, i) => '"k' + i + '":0').join(",");
    expect(parseBoundedPolicyJson('{' + pairs(1_000) + '}')).toBeDefined();
    expect(parseBoundedPolicyJson('{' + pairs(1_001) + '}')).toBeUndefined();
  });
  it("accepts the exact depth limit and rejects one level deeper", () => {
    expect(parseBoundedPolicyJson("[".repeat(32) + "0" + "]".repeat(32))).toBeDefined();
    expect(parseBoundedPolicyJson("[".repeat(33) + "0" + "]".repeat(33))).toBeUndefined();
  });
  it("rejects excessive array entries", () => {
    expect(parseBoundedPolicyJson("[" + Array.from({ length: 1_001 }, () => "0").join(",") + "]")).toBeUndefined();
  });
  it("enforces the 10,000-node limit independently of the per-container entry limit", () => {
    const atLimit = Array.from({ length: 10 }, (_, index) =>
      "[" + Array.from({ length: index === 9 ? 998 : 999 }, () => "0").join(",") + "]");
    const overLimit = Array.from({ length: 10 }, () =>
      "[" + Array.from({ length: 999 }, () => "0").join(",") + "]");

    // Root + 10 nested arrays + 9,989 scalar values = exactly 10,000 nodes.
    expect(parseBoundedPolicyJson("[" + atLimit.join(",") + "]")).toBeDefined();
    expect(parseBoundedPolicyJson("[" + overLimit.join(",") + "]")).toBeUndefined();
  });
  it("enforces per-string and aggregate UTF-8 budgets including array index keys", () => {
    expect(parseBoundedPolicyJson(JSON.stringify("é".repeat(8_192)))).toBeDefined();
    expect(parseBoundedPolicyJson(JSON.stringify("é".repeat(8_193)))).toBeUndefined();
    const atLimit = JSON.stringify(Array.from({ length: 16 }, (_, i) => "é".repeat(i === 15 ? 8_181 : 8_192)));
    const overLimit = JSON.stringify(Array.from({ length: 16 }, (_, i) => "é".repeat(i === 15 ? 8_182 : 8_192)));
    expect(parseBoundedPolicyJson(atLimit)).toBeDefined();
    expect(parseBoundedPolicyJson(overLimit)).toBeUndefined();
  });
  it("rejects malformed JSON, duplicate keys, trailing data, and non-finite numbers", () => {
    for (const value of ['{"a":1,"a":2}', '{"a":', '{"a":1} trailing', "NaN", "1e999", "[1,]"]) {
      expect(parseBoundedPolicyJson(value)).toBeUndefined();
    }
  });
  it("handles escaped strings and UTF-8 keys", () => {
    expect(parseBoundedPolicyJson('{"é":"line\\nnext","quote":"\\""}')).toEqual({ "é": "line\nnext", quote: '"' });
  });
});
