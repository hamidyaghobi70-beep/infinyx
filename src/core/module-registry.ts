import type { CoreModule } from "./contracts.js";
import { CoreError } from "./core-error.js";

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
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) {
      if (!Object.prototype.hasOwnProperty.call(descriptor, "value")) {
        throw invalidModule();
      }
      const hook: unknown = descriptor.value;
      if (hook === undefined) return undefined;
      if (typeof hook !== "function") throw invalidModule();
      return hook.bind(target);
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
      lengthDescriptor.value < 0) {
    throw invalidModule();
  }

  const dependencies: string[] = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor ||
        !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
        typeof descriptor.value !== "string") {
      throw invalidModule();
    }
    dependencies.push(descriptor.value);
  }
  return Object.freeze(dependencies);
}

export class ModuleRegistry {
  private readonly modules = new Map<string, CoreModule>();

  register(module: CoreModule): void {
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
          !/^[a-z][a-z0-9-]*$/.test(id) ||
          typeof version !== "string" ||
          !version.trim()) {
        throw invalidModule();
      }

      if (this.modules.has(id)) {
        throw new CoreError("DUPLICATE_MODULE", 'Module "' + id + '" is already registered.');
      }

      if (dependencies.includes(id)) {
        throw new CoreError("MODULE_DEPENDENCY_CYCLE", 'Module "' + id + '" cannot depend on itself.');
      }

      // Preserve class-instance receivers while capturing stable callable hooks.
      const registered: CoreModule = {
        id,
        version,
        dependencies,
        ...(readLifecycleHook(module, "initialize")
          ? { initialize: readLifecycleHook(module, "initialize") }
          : {}),
        ...(readLifecycleHook(module, "start")
          ? { start: readLifecycleHook(module, "start") }
          : {}),
        ...(readLifecycleHook(module, "stop")
          ? { stop: readLifecycleHook(module, "stop") }
          : {})
      };

      this.modules.set(id, Object.freeze(registered));
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
