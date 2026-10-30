import type { CoreModule } from "./contracts.js";
import { CoreError } from "./core-error.js";

export class ModuleRegistry {
  private readonly modules = new Map<string, CoreModule>();

  register(module: CoreModule): void {
    if (!/^[a-z][a-z0-9-]*$/.test(module.id) || !module.version.trim()) {
      throw new CoreError(
        "INVALID_MODULE",
        "A module requires a lowercase kebab-case id and a non-empty version."
      );
    }

    if (this.modules.has(module.id)) {
      throw new CoreError("DUPLICATE_MODULE", 'Module "' + module.id + '" is already registered.');
    }

    const dependencies = [...(module.dependencies ?? [])];
    if (dependencies.includes(module.id)) {
      throw new CoreError("MODULE_DEPENDENCY_CYCLE", 'Module "' + module.id + '" cannot depend on itself.');
    }

    this.modules.set(module.id, Object.freeze({ ...module, dependencies: Object.freeze(dependencies) }));
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
