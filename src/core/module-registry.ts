import type { CoreModule } from "./contracts.js";
import { CoreError } from "./core-error.js";

const MAX_LIFECYCLE_PROTOTYPE_DEPTH = 64;

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

export class ModuleRegistry {
  private readonly modules = new Map<string, CoreModule>();

  register(module: CoreModule): void {
    let id: unknown;
    let version: unknown;
    let rawDependencies: unknown;
    let initialize: unknown;
    let start: unknown;
    let stop: unknown;
    try {
      if (!module || typeof module !== "object") throw new TypeError("Invalid module.");
      // Read caller-controlled properties once. Re-reading accessors after validation
      // would permit metadata and lifecycle hooks to change between check and storage.
      id = module.id;
      version = module.version;
      rawDependencies = module.dependencies;
      initialize = readLifecycleHook(module, "initialize");
      start = readLifecycleHook(module, "start");
      stop = readLifecycleHook(module, "stop");
    } catch {
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
    if (rawDependencies !== undefined &&
        (!Array.isArray(rawDependencies) ||
         rawDependencies.some((dependency) => typeof dependency !== "string" ||
           !/^[a-z][a-z0-9-]*$/.test(dependency)))) {
      throw new CoreError("INVALID_MODULE", "Module dependencies must be valid module identifiers.");
    }

    if (this.modules.has(id)) {
      throw new CoreError("DUPLICATE_MODULE", 'Module "' + id + '" is already registered.');
    }

    const dependencies = [...(rawDependencies ?? [])] as string[];
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
