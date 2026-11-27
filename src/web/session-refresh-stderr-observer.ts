import type { SessionRefreshEvent, SessionRefreshObserver } from "./session-refresh-observer.js";

/**
 * Writes allow-listed refresh lifecycle records to the process error stream.
 * The record deliberately contains no request, account, session, or provider data.
 */
export class StderrSessionRefreshObserver implements SessionRefreshObserver {
  constructor(
    private readonly writeLine: (line: string) => void = line => {
      process.stderr.write(line);
    }
  ) {}

  onEvent(event: SessionRefreshEvent): void {
    const record = {
      timestamp: new Date().toISOString(),
      component: "web_session_refresh",
      event
    };
    this.writeLine(`${JSON.stringify(record)}\n`);
  }
}
