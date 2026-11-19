import type { CoreModule } from "./contracts.js";
import { CoreError } from "./core-error.js";

export const MAX_CORE_MODULES = 256;
export const MAX_MODULE_DEPENDENCIES = 64;
export const MAX_TOTAL_MODULE_DEPENDENCIES = 4_096;
export const MAX_MODULE_ID_LENGTH = 128;
export const MAX_MODULE_VERSION_LENGTH = 128;
const MAX_PROTOTYPE_CHAIN_DEPTH = 64;

function invalidModule(): CoreError {
  return new CoreError(
    "INVALID_MODULE",
    "Module metadata and lifecycle hooks must be stable data properties."
  );
}

function readOwnDataProperty(target: object, key: string, required: boolean): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (!descriptor) {
    if (required) throw invalidModule();
    return undefined;
  }
  if (!Object.prototype.hasOwnProperty.call(descriptor, "value")) {
    throw invalidModule();
  }
  return descriptor.value;
}

function readLifecycleHook(
  target: object,
  key: "initialize" | "start" | "stop"
): CoreModule["initialize"] | CoreModule["start"] | CoreModule["stop"] {
  let current: object | null = target;
  const visited = new Set<object>();
  while (current !== null) {
    if (visited.has(current) || visited.size >= MAX_PROTOTYPE_CHAIN_DEPTH) throw invalidModule();
    visited.add(current);
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) {
      if (!Object.prototype.hasOwnProperty.call(descriptor, "value")) {
        throw invalidModule();
      }
      const hook: unknown = descriptor.value;
      if (hook === undefined) return undefined;
      if (typeof hook !== "function") throw invalidModule();
      return Function.prototype.bind.call(hook, target);
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return undefined;
}

function snapshotDependencies(value: unknown): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw invalidModule();

  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor ||
      !Object.prototype.hasOwnProperty.call(lengthDescriptor, "value") ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0 ||
      lengthDescriptor.value > MAX_MODULE_DEPENDENCIES) {
    throw invalidModule();
  }

  // Treat the dependency array as an exact data record: no hidden slots,
  // sparse entries, symbols, or caller-defined side properties are accepted.
  const expectedKeys = new Set<string>(["length"]);
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    expectedKeys.add(String(index));
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== expectedKeys.size ||
      ownKeys.some((key) => typeof key !== "string" || !expectedKeys.has(key))) {
    throw invalidModule();
  }

  const dependencies: string[] = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor ||
        descriptor.enumerable !== true ||
        !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
        typeof descriptor.value !== "string" ||
        descriptor.value.length > MAX_MODULE_ID_LENGTH ||
        !/^[a-z][a-z0-9-]*$/.test(descriptor.value)) {
      throw invalidModule();
    }
    dependencies.push(descriptor.value);
  }
  if (new Set(dependencies).size !== dependencies.length) throw invalidModule();
  return Object.freeze(dependencies);
}

export class ModuleRegistry {
  private readonly modules = new Map<string, CoreModule>();
  private totalDependencies = 0;

  register(module: CoreModule): CoreModule {
    try {
      if ((typeof module !== "object" && typeof module !== "function") || module === null) {
        throw invalidModule();
      }

      // Read each metadata field once through its own data descriptor. Accessors
      // are rejected so registration cannot execute caller-controlled getters.
      const id = readOwnDataProperty(module, "id", true);
      const version = readOwnDataProperty(module, "version", true);
      const dependencies = snapshotDependencies(
        readOwnDataProperty(module, "dependencies", false)
      );

      if (typeof id !== "string" ||
          id.length > MAX_MODULE_ID_LENGTH ||
          !/^[a-z][a-z0-9-]*$/.test(id) ||
          typeof version !== "string" ||
          !version.trim() ||
          version.length > MAX_MODULE_VERSION_LENGTH) {
        throw invalidModule();
      }

      if (this.modules.has(id)) {
        throw new CoreError("DUPLICATE_MODULE", 'Module "' + id + '" is already registered.');
      }

      if (this.modules.size >= MAX_CORE_MODULES ||
          this.totalDependencies + dependencies.length > MAX_TOTAL_MODULE_DEPENDENCIES) {
        throw invalidModule();
      }

      if (dependencies.includes(id)) {
        throw new CoreError("MODULE_DEPENDENCY_CYCLE", 'Module "' + id + '" cannot depend on itself.');
      }

      // Resolve each hook exactly once while preserving class-instance receivers.
      const initialize = readLifecycleHook(module, "initialize");
      const start = readLifecycleHook(module, "start");
      const stop = readLifecycleHook(module, "stop");
      const registered: CoreModule = {
        id,
        version,
        dependencies,
        ...(initialize ? { initialize } : {}),
        ...(start ? { start } : {}),
        ...(stop ? { stop } : {})
      };

      const snapshot = Object.freeze(registered);
      this.modules.set(id, snapshot);
      this.totalDependencies += dependencies.length;
      return snapshot;
    } catch (error) {
      if (error instanceof CoreError) throw error;
      throw invalidModule();
    }
  }

  get(id: string): CoreModule | undefined {
    return this.modules.get(id);
  }

  list(): readonly CoreModule[] {
    return [...this.modules.values()];
  }

  resolveStartOrder(): readonly CoreModule[] {
    const resolved: CoreModule[] = [];
    const visited = new Set<string>();
    const visiting: string[] = [];

    const visit = (id: string): void => {
      if (visited.has(id)) return;

      const cycleStart = visiting.indexOf(id);
      if (cycleStart !== -1) {
        const cycle = [...visiting.slice(cycleStart), id].join(" -> ");
        throw new CoreError("MODULE_DEPENDENCY_CYCLE", "Module dependency cycle: " + cycle);
      }

      const module = this.modules.get(id);
      if (!module) {
        throw new CoreError("UNKNOWN_DEPENDENCY", 'Module dependency "' + id + '" is not registered.');
      }

      visiting.push(id);
      for (const dependency of module.dependencies ?? []) visit(dependency);
      visiting.pop();
      visited.add(id);
      resolved.push(module);
    };

    for (const id of this.modules.keys()) visit(id);
    return resolved;
  }
}
