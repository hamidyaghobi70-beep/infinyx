import { CoreEngine } from "./core-engine.js";
import type { CoreEngineOptions } from "./core-engine.js";

/**
 * Strict production composition root.
 *
 * Until an OS-level process-tree supervisor is integrated and verified, this
 * factory intentionally permits only the built-in default-deny policy. A
 * Node.js child process alone is not sufficient containment for evaluator
 * code that may create descendants.
 */
export function createProductionCoreEngine(
  options: Omit<CoreEngineOptions, "requireProcessIsolation"> = {}
): CoreEngine {
  if (options.policy) {
    throw new TypeError(
      "Custom policy evaluators are disabled in the production factory until verified OS-level process-tree supervision is available."
    );
  }

  return new CoreEngine({
    ...options,
    requireProcessIsolation: true
  });
}
