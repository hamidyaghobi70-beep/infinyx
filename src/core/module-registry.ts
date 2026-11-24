import type { CoreModule } from "./contracts.js";
import { CoreError } from "./core-error.js";

const MAX_LIFECYCLE_PROTOTYPE_DEPTH = 64;
const MAX_MODULE_DEPENDENCIES = 256;

function readLifecycleHook(
  target: object,
  key: "initialize" | "start" | "stop"
): unknown {
  let current: object | null = target;
  const visited = new Set<object>();
  try {
    while (current !== null) {
      if (visited.has(current) || visited.size >= MAX_LIFECYCLE_PROTOTYPE_DEPTH) {
        throw new TypeError("Invalid module lifecycle prototype chain.");
      }
      visited.add(current);
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor) {
        if (!Object.prototype.hasOwnProperty.call(descriptor, "value")) {
          throw new TypeError("Module lifecycle hooks must be data properties.");
        }
        return descriptor.value;
      }
      current = Object.getPrototypeOf(current) as object | null;
    }
    return undefined;
  } catch {
    throw new CoreError("INVALID_MODULE", "Module lifecycle hooks must be readable stable data methods.");
  }
}

/** Snapshot dependency array data descriptors once; never execute dependency getters. */
function snapshotDependencies(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new CoreError("INVALID_MODULE", "Module dependencies must be valid module identifiers.");
  }

  let descriptors: Record<string, PropertyDescriptor>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
  } catch {
    throw new CoreError("INVALID_MODULE", "Module dependencies must be readable stable data values.");
  }

  const lengthDescriptor = descriptors.length;
  const length = lengthDescriptor?.value;
  if (!lengthDescriptor || !("value" in lengthDescriptor) ||
      !Number.isSafeInteger(length) || length < 0 || length > MAX_MODULE_DEPENDENCIES) {
    throw new CoreError("INVALID_MODULE", "Module dependency count is invalid.");
  }

  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== length + 1 ||
      keys.some((key) => key !== "length" &&
        (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length))) {
    throw new CoreError("INVALID_MODULE", "Module dependency collections cannot contain extra properties.");
  }

  const dependencies: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable ||
        typeof descriptor.value !== "string" || !/^[a-z][a-z0-9-]*$/.test(descriptor.value)) {
      throw new CoreError("INVALID_MODULE", "Module dependencies must be dense data properties with valid identifiers.");
    }
    dependencies.push(descriptor.value);
  }
  return dependencies;
}

export class ModuleRegistry {
  private readonly modules = new Map<string, CoreModule>();

  register(module: CoreModule): void {
    let id: unknown;
    let version: unknown;
    let dependencies: string[];
    let initialize: unknown;
    let start: unknown;
    let stop: unknown;
    try {
      if (!module || typeof module !== "object") throw new TypeError("Invalid module.");
      // Read caller-controlled metadata once. Dependencies are copied from own data
      // descriptors so accessors, sparse arrays, and later mutation cannot change
      // the registry's validated dependency graph.
      id = module.id;
      version = module.version;
      dependencies = snapshotDependencies(module.dependencies);
      initialize = readLifecycleHook(module, "initialize");
      start = readLifecycleHook(module, "start");
      stop = readLifecycleHook(module, "stop");
    } catch (error) {
      if (error instanceof CoreError) throw error;
      throw new CoreError("INVALID_MODULE", "Module metadata and lifecycle hooks must be readable.");
    }

    if (typeof id !== "string" || !/^[a-z][a-z0-9-]*$/.test(id) ||
        typeof version !== "string" || !version.trim()) {
      throw new CoreError(
        "INVALID_MODULE",
        "A module requires a lowercase kebab-case id and a non-empty version."
      );
    }
    if ([initialize, start, stop].some((hook) => hook !== undefined && typeof hook !== "function")) {
      throw new CoreError("INVALID_MODULE", "Module lifecycle hooks must be functions when provided.");
    }

    if (this.modules.has(id)) {
      throw new CoreError("DUPLICATE_MODULE", 'Module "' + id + '" is already registered.');
    }

    if (dependencies.includes(id)) {
      throw new CoreError("MODULE_DEPENDENCY_CYCLE", 'Module "' + id + '" cannot depend on itself.');
    }

    // Snapshot registry metadata while retaining the source instance as the
    // receiver for prototype methods on class-based CoreModule implementations.
    const registered: CoreModule = {
      id,
      version,
      dependencies: Object.freeze(dependencies),
      ...(typeof initialize === "function" ? { initialize: initialize.bind(module) } : {}),
      ...(typeof start === "function" ? { start: start.bind(module) } : {}),
      ...(typeof stop === "function" ? { stop: stop.bind(module) } : {})
    };

    this.modules.set(id, Object.freeze(registered));
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
