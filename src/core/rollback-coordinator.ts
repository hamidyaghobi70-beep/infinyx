/**
 * Coordinates rollback work so concurrent shutdown paths share one settlement.
 *
 * The shared promise is cleared after either fulfillment or rejection, allowing
 * a later caller to retry cleanup after a failed attempt. Rejections are passed
 * through unchanged so callers retain the original failure and its causes.
 */
export class RollbackCoordinator {
  private inFlight: Promise<unknown> | undefined;

  run(operation: () => Promise<void>): Promise<void> {
    if (this.inFlight) {
      return this.inFlight as Promise<void>;
    }

    const attempt = Promise.resolve().then(operation);
    this.inFlight = attempt;

    const clear = (): void => {
      if (this.inFlight === attempt) {
        this.inFlight = undefined;
      }
    };
    void attempt.then(clear, clear);

    return attempt;
  }

  get isRunning(): boolean {
    return this.inFlight !== undefined;
  }
}
