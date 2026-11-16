/**
 * Creates a bounded, detached, deeply immutable snapshot of structured data.
 *
 * This helper rejects accessors without invoking them. Reflective operations can
 * still trigger Proxy traps; callers must use a controlled data/serialization
 * boundary when input may contain hostile in-process Proxy objects.
 */

const MAX_DEPTH = 32;
const MAX_NODES = 10_000;
const MAX_STRING_BYTES = 16_384;
const MAX_TOTAL_BYTES = 262_144;
const MAX_CONTAINER_ENTRIES = 1_000;

export type DeepReadonly<T> =
  T extends (...args: never[]) => unknown ? never
    : T extends readonly (infer TItem)[] ? readonly DeepReadonly<TItem>[]
      : T extends object ? { readonly [TKey in keyof T]: DeepReadonly<T[TKey]> }
        : T;

export type SnapshotFailureReason =
  | "RESOURCE_LIMIT"
  | "UNSUPPORTED_VALUE"
  | "CIRCULAR_REFERENCE"
  | "ACCESSOR_PROPERTY"
  | "INVALID_STRUCTURE";

export type SnapshotResult<T> =
  | { readonly ok: true; readonly value: DeepReadonly<T> }
  | { readonly ok: false; readonly reason: SnapshotFailureReason };

interface SnapshotFailure {
  readonly snapshotFailure: SnapshotFailureReason;
}

function reject(reason: SnapshotFailureReason): never {
  throw { snapshotFailure: reason } satisfies SnapshotFailure;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * Snapshot limits:
 * - depth is zero-based (the root is depth 0)
 * - every visited primitive or container counts as one node
 * - every own enumerable string key and every string value counts toward
 *   both the per-string and aggregate UTF-8 byte limits
 * - container entry limits exclude the intrinsic array length property
 */
export function snapshotBoundedPolicyData<T>(input: T): SnapshotResult<T> {
  let nodes = 0;
  let totalBytes = 0;
  const ancestors = new Set<object>();

  const accountString = (value: string): void => {
    const bytes = byteLength(value);
    if (bytes > MAX_STRING_BYTES) reject("RESOURCE_LIMIT");
    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_BYTES) reject("RESOURCE_LIMIT");
  };

  const clone = (value: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_NODES || depth > MAX_DEPTH) reject("RESOURCE_LIMIT");

    if (value === null || typeof value === "boolean" || typeof value === "undefined") {
      return value;
    }

    if (typeof value === "string") {
      accountString(value);
      return value;
    }

    if (typeof value === "number") {
      if (!Number.isFinite(value)) reject("UNSUPPORTED_VALUE");
      return value;
    }

    if (typeof value !== "object") reject("UNSUPPORTED_VALUE");
    if (ancestors.has(value)) reject("CIRCULAR_REFERENCE");

    const isArray = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (
      (isArray && prototype !== Array.prototype) ||
      (!isArray && prototype !== Object.prototype && prototype !== null)
    ) {
      reject("UNSUPPORTED_VALUE");
    }

    ancestors.add(value);
    try {
      const keys = Reflect.ownKeys(value);

      if (isArray) {
        if (keys.some((key) =>
          typeof key === "symbol" ||
          (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key))
        )) {
          reject("INVALID_STRUCTURE");
        }

        if (value.length > MAX_CONTAINER_ENTRIES || keys.length !== value.length + 1) {
          reject("RESOURCE_LIMIT");
        }

        const result: unknown[] = [];
        for (let index = 0; index < value.length; index += 1) {
          const key = String(index);
          accountString(key);
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
            reject("ACCESSOR_PROPERTY");
          }
          result.push(clone(descriptor.value, depth + 1));
        }
        return Object.freeze(result);
      }

      if (keys.length > MAX_CONTAINER_ENTRIES) reject("RESOURCE_LIMIT");
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

      for (const key of keys) {
        if (typeof key !== "string") reject("INVALID_STRUCTURE");
        accountString(key);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          reject("ACCESSOR_PROPERTY");
        }
        Object.defineProperty(result, key, {
          configurable: false,
          enumerable: true,
          writable: false,
          value: clone(descriptor.value, depth + 1)
        });
      }

      return Object.freeze(result);
    } finally {
      ancestors.delete(value);
    }
  };

  try {
    return { ok: true, value: clone(input, 0) as DeepReadonly<T> };
  } catch (error) {
    if (typeof error === "object" && error !== null && "snapshotFailure" in error) {
      const reason = error.snapshotFailure;
      if (
        reason === "RESOURCE_LIMIT" ||
        reason === "UNSUPPORTED_VALUE" ||
        reason === "CIRCULAR_REFERENCE" ||
        reason === "ACCESSOR_PROPERTY" ||
        reason === "INVALID_STRUCTURE"
      ) {
        return { ok: false, reason };
      }
    }

    // Reflection on hostile or revoked Proxies may throw. Do not expose the
    // underlying exception or execute fallback logic on the original object.
    return { ok: false, reason: "INVALID_STRUCTURE" };
  }
}
