import type { EventBusPort, EventEnvelope, EventHandler } from "./contracts.js";

export class InMemoryEventBus implements EventBusPort {
  private readonly handlers = new Map<string, Set<EventHandler<unknown>>>();

  subscribe<TPayload>(type: string, handler: EventHandler<TPayload>): () => void {
    if (!type.trim()) {
      throw new TypeError("Event type must be a non-empty string.");
    }

    const bucket = this.handlers.get(type) ?? new Set<EventHandler<unknown>>();
    const registeredHandler = handler as EventHandler<unknown>;
    bucket.add(registeredHandler);
    this.handlers.set(type, bucket);

    return () => {
      bucket.delete(registeredHandler);
      if (bucket.size === 0) this.handlers.delete(type);
    };
  }

  hasSubscribers(type: string): boolean {
    return (this.handlers.get(type)?.size ?? 0) > 0;
  }

  async publish<TPayload>(type: string, payload: TPayload): Promise<void> {
    await this.dispatch(type, payload, false);
  }

  async publishIfSubscribed<TPayload>(type: string, payload: TPayload): Promise<boolean> {
    return this.dispatch(type, payload, true);
  }

  /**
   * The handler snapshot is taken synchronously before the first await. This makes
   * the subscriber check and dispatch selection one atomic event-loop operation.
   */
  private async dispatch<TPayload>(
    type: string,
    payload: TPayload,
    requireSubscriber: boolean
  ): Promise<boolean> {
    if (!type.trim()) {
      throw new TypeError("Event type must be a non-empty string.");
    }

    const handlers = [...(this.handlers.get(type) ?? [])];
    if (requireSubscriber && handlers.length === 0) return false;

    const envelope: EventEnvelope<TPayload> = Object.freeze({
      type,
      payload,
      occurredAt: new Date()
    });
    const results = await Promise.allSettled(
      handlers.map((handler) =>
        Promise.resolve().then(() => handler(envelope as EventEnvelope<unknown>))
      )
    );
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);

    if (failures.length > 0) {
      throw new AggregateError(failures, "One or more event handlers failed.");
    }
    return handlers.length > 0;
  }
}
