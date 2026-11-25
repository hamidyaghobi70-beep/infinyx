import { types as utilTypes } from "node:util";

const MAX_DEPTH = 32;
const MAX_NODES = 10_000;
const MAX_STRING_BYTES = 16_384;
const MAX_TOTAL_BYTES = 262_144;
const MAX_CONTAINER_ENTRIES = 1_000;

function byteLength(value: string): number {
  // Buffer.byteLength computes UTF-8 length without allocating an encoded copy.
  return Buffer.byteLength(value, "utf8");
}

/**
 * Bounded, getter-free snapshot for ordinary data objects.
 *
 * Proxy values are rejected before reflective inspection, including when
 * nested. This is not a sandbox for arbitrary same-process objects; callers
 * must still pass trusted plain data structures.
 */
export function snapshotBoundedPolicyData<T>(input: T): T | undefined {
  let nodes = 0;
  let totalBytes = 0;
  const ancestors = new Set<object>();

  const accountString = (value: string): boolean => {
    const bytes = byteLength(value);
    if (bytes > MAX_STRING_BYTES) return false;
    totalBytes += bytes;
    return totalBytes <= MAX_TOTAL_BYTES;
  };

  const clone = (value: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_NODES || depth > MAX_DEPTH) throw new TypeError("Policy input exceeds resource limits.");
    if (value === null || typeof value === "boolean" || typeof value === "undefined") return value;
    if (typeof value === "string") {
      if (!accountString(value)) throw new TypeError("Policy input exceeds resource limits.");
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new TypeError("Policy input contains a non-finite number.");
      return value;
    }
    if (typeof value !== "object" || ancestors.has(value)) {
      throw new TypeError("Policy input contains an unsupported value or cycle.");
    }
    // Reject same-process Proxies before prototype, key, or descriptor reflection.
    // util.types.isProxy is a Node.js type check and does not invoke Proxy traps.
    if (utilTypes.isProxy(value)) {
      throw new TypeError("Policy input must not contain Proxy objects.");
    }

    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (!array && prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Policy input must contain only plain records and arrays.");
    }
    ancestors.add(value);
    try {
      if (array) {
        // Read length from its own data descriptor rather than performing a property get.
        const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
        if (!lengthDescriptor || !("value" in lengthDescriptor) ||
            typeof lengthDescriptor.value !== "number" ||
            !Number.isSafeInteger(lengthDescriptor.value)) {
          throw new TypeError("Policy array length is invalid.");
        }
        const length = lengthDescriptor.value;
        // Reject oversized ordinary arrays before own-key enumeration.
        if (length > MAX_CONTAINER_ENTRIES) {
          throw new TypeError("Policy input exceeds resource limits.");
        }
        const keys = Reflect.ownKeys(value);
        // Reflect.ownKeys has already materialized the complete key list at
        // this point; this count does not cap that allocation. Proxy inputs
        // are rejected before reaching this reflection operation.
        if (keys.length > MAX_CONTAINER_ENTRIES + 1) {
          throw new TypeError("Policy input exceeds resource limits.");
        }
        if (keys.some((key) => typeof key === "symbol" ||
            (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key)))) {
          throw new TypeError("Policy arrays contain unsupported properties.");
        }
        if (keys.length !== length + 1) {
          throw new TypeError("Policy input contains sparse arrays.");
        }
        const result: unknown[] = [];
        for (let index = 0; index < length; index += 1) {
          // Numeric array index keys share the aggregate UTF-8 key budget.
          // The structural "length" property is intentionally excluded.
          if (!accountString(String(index))) {
            throw new TypeError("Policy input exceeds resource limits.");
          }
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
            throw new TypeError("Policy input accessors are not supported.");
          }
          result.push(clone(descriptor.value, depth + 1));
        }
        return Object.freeze(result);
      }

      // Reflection materializes every own key before this limit is enforceable.
      // This is a traversal bound, not a pre-allocation memory bound.
      const keys = Reflect.ownKeys(value);
      if (keys.length > MAX_CONTAINER_ENTRIES || keys.some((key) => typeof key !== "string")) {
        throw new TypeError("Policy input exceeds resource limits or contains symbol keys.");
      }
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const key of keys as string[]) {
        if (!accountString(key)) throw new TypeError("Policy input exceeds resource limits.");
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          throw new TypeError("Policy input accessors and hidden properties are not supported.");
        }
        result[key] = clone(descriptor.value, depth + 1);
      }
      return Object.freeze(result);
    } finally {
      ancestors.delete(value);
    }
  };

  try {
    return clone(input, 0) as T;
  } catch {
    return undefined;
  }
}
