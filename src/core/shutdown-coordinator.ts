export type ShutdownFailureStage = "http-server" | "core-engine";

export interface ShutdownCoordinatorOptions {
  readonly closeServer: () => Promise<void>;
  readonly stopCore: () => Promise<void>;
  readonly onStart?: (signal: string) => void;
  readonly onFailure: (stage: ShutdownFailureStage, error: unknown) => void;
}

/**
 * Coordinates process shutdown as one shared operation.
 * Concurrent or repeated signals receive the same promise and cannot run
 * HTTP close or Core Engine cleanup more than once.
 */
export function createShutdownCoordinator(
  options: ShutdownCoordinatorOptions
): (signal: string) => Promise<void> {
  let shutdownPromise: Promise<void> | undefined;

  return (signal: string): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;

    options.onStart?.(signal);
    shutdownPromise = (async () => {
      try {
        await options.closeServer();
      } catch (error) {
        options.onFailure("http-server", error);
      }

      try {
        await options.stopCore();
      } catch (error) {
        options.onFailure("core-engine", error);
      }
    })();

    return shutdownPromise;
  };
}
