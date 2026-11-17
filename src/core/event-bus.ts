import type { EventBusPort, EventEnvelope, EventHandler } from "./contracts.js";
import { snapshotBoundedPolicyData } from "./policy-input-snapshot.js";

const MAX_EVENT_TYPE_LENGTH = 128;
const MAX_SUBSCRIBERS_PER_TYPE = 256;
const MAX_TOTAL_SUBSCRIBERS = 4_096;
const MAX_ACTIVE_DISPATCHES = 256;

function validateEventType(type: unknown): asserts type is string {
  if (typeof type !== "string" || type.length === 0 ||
      type.length > MAX_EVENT_TYPE_LENGTH || type.trim() !== type) {
    throw new TypeError("Event type must be a bounded, non-empty string.");
  }
}

export class InMemoryEventBus implements EventBusPort {
  private readonly handlers = new Map<string, Set<EventHandler<unknown>>>();
  private totalSubscribers = 0;
  private activeDispatches = 0;

  subscribe<TPayload>(type: string, handler: EventHandler<TPayload>): () => void {
    validateEventType(type);
    if (typeof handler !== "function") {
      throw new TypeError("Event handler must be a function.");
    }

    const bucket = this.handlers.get(type) ?? new Set<EventHandler<unknown>>();
    const registeredHandler = handler as EventHandler<unknown>;
    if (bucket.has(registeredHandler)) {
      return () => undefined;
    }
    if (bucket.size >= MAX_SUBSCRIBERS_PER_TYPE ||
        this.totalSubscribers >= MAX_TOTAL_SUBSCRIBERS) {
      throw new RangeError("Event subscriber capacity has been reached.");
    }

    bucket.add(registeredHandler);
    this.handlers.set(type, bucket);
    this.totalSubscribers += 1;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.removeSubscriber(type, bucket, registeredHandler);
    };
  }

  private removeSubscriber(
    type: string,
    bucket: Set<EventHandler<unknown>>,
    handler: EventHandler<unknown>
  ): void {
    if (!bucket.delete(handler)) return;
    this.totalSubscribers -= 1;
    if (bucket.size === 0 && this.handlers.get(type) === bucket) {
      this.handlers.delete(type);
    }
  }

  hasSubscribers(type: string): boolean {
    validateEventType(type);
    return (this.handlers.get(type)?.size ?? 0) > 0;
  }

  async publish<TPayload>(type: string, payload: TPayload): Promise<void> {
    await this.dispatch(type, payload, false);
  }

  async publishIfSubscribed<TPayload>(type: string, payload: TPayload): Promise<boolean> {
    return this.dispatch(type, payload, true);
  }

  /**
   * Subscriber selection and capacity admission occur synchronously before the
   * first await. Every delivery receives a bounded immutable payload snapshot.
   */
  private async dispatch<TPayload>(
    type: string,
    payload: TPayload,
    requireSubscriber: boolean
  ): Promise<boolean> {
    validateEventType(type);
    const handlers = [...(this.handlers.get(type) ?? [])];
    if (requireSubscriber && handlers.length === 0) return false;
    if (handlers.length === 0) return false;
    if (this.activeDispatches >= MAX_ACTIVE_DISPATCHES) {
      throw new RangeError("Event dispatch capacity has been reached.");
    }

    const snapshot = snapshotBoundedPolicyData(payload);
    if (!snapshot.ok) {
      throw new TypeError("Event payload is not valid bounded structured data.");
    }

    this.activeDispatches += 1;
    const occurredAt = Date.now();
    const envelope = Object.freeze({
      type,
      payload: snapshot.value,
      get occurredAt(): Date { return new Date(occurredAt); }
    }) as unknown as EventEnvelope<TPayload>;

    try {
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
      return true;
    } finally {
      this.activeDispatches -= 1;
    }
  }
}
