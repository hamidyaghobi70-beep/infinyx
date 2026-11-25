import { describe, expect, it, vi } from "vitest";
import { isValidPolicyDecision, snapshotPolicyDecision } from "../../src/core/fail-closed-policy-engine.js";

describe("policy decision snapshot boundary", () => {
  it("returns a detached deeply frozen decision", () => {
    const source = { effect: "allow" as const, reason: "approved", metadata: { note: "extra" } };
    const result = snapshotPolicyDecision(source);
    source.reason = "changed";
    expect(result).toEqual({ effect: "allow", reason: "approved" });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("rejects an accessor without invoking it", () => {
    const getter = vi.fn(() => "allow");
    const value = Object.defineProperties({}, {
      effect: { enumerable: true, get: getter },
      reason: { enumerable: true, value: "approved" }
    });
    expect(snapshotPolicyDecision(value)).toBeUndefined();
    expect(isValidPolicyDecision(value)).toBe(false);
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects Proxy decisions without invoking traps", () => {
    const trap = vi.fn(() => ({ effect: "allow", reason: "approved" }));
    const value = new Proxy({}, { ownKeys: trap });
    expect(snapshotPolicyDecision(value)).toBeUndefined();
    expect(isValidPolicyDecision(value)).toBe(false);
    expect(trap).not.toHaveBeenCalled();
  });

  it("rejects nested Proxy and accessor values", () => {
    const nestedTrap = vi.fn(() => []);
    const nestedProxy = new Proxy({}, { ownKeys: nestedTrap });
    expect(snapshotPolicyDecision({ effect: "allow", reason: "ok", nested: nestedProxy })).toBeUndefined();
    expect(nestedTrap).not.toHaveBeenCalled();

    const nestedGetter = vi.fn(() => "secret");
    const nested = Object.defineProperty({}, "value", { enumerable: true, get: nestedGetter });
    expect(snapshotPolicyDecision({ effect: "allow", reason: "ok", nested })).toBeUndefined();
    expect(nestedGetter).not.toHaveBeenCalled();
  });

  it("rejects invalid decisions after snapshotting", () => {
    expect(snapshotPolicyDecision({ effect: "permit", reason: "no" })).toBeUndefined();
    expect(snapshotPolicyDecision({ effect: "deny", reason: " " })).toBeUndefined();
    expect(snapshotPolicyDecision(null)).toBeUndefined();
  });
});
