export type SessionRefreshEvent =
  | "reservation_claimed"
  | "reservation_conflict"
  | "provider_failed"
  | "provider_response_rejected"
  | "persistence_succeeded"
  | "persistence_conflict"
  | "persistence_failed";

/**
 * Receives secret-free refresh lifecycle events.
 * Implementations must not add session, user, attempt, or token identifiers.
 */
export interface SessionRefreshObserver {
  onEvent(event: SessionRefreshEvent): void;
}

export const NOOP_SESSION_REFRESH_OBSERVER: SessionRefreshObserver = Object.freeze({
  onEvent: (_event: SessionRefreshEvent): void => {}
});
