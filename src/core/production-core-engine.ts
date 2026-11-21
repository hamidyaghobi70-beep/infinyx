import { CoreEngine } from "./core-engine.js";
import type { CoreEngineOptions } from "./core-engine.js";

/**
 * Composition-root factory for production runtimes.
 *
 * Any custom policy evaluator supplied here must use the child-process
 * ProcessIsolatedPolicyEngine. Keep direct CoreEngine construction for
 * lower-level/test use where the caller owns the trust decision.
 */
export function createProductionCoreEngine(
  options: Omit<CoreEngineOptions, "requireProcessIsolation"> = {}
): CoreEngine {
  return new CoreEngine({
    ...options,
    requireProcessIsolation: true
  });
}
