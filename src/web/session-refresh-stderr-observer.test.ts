import { describe, expect, it, vi } from "vitest";
import { StderrSessionRefreshObserver } from "./session-refresh-stderr-observer.js";

describe("StderrSessionRefreshObserver", () => {
  it("writes one structured record containing only the timestamp, component, and fixed event", () => {
    const writeLine = vi.fn<(line: string) => void>();
    const observer = new StderrSessionRefreshObserver(writeLine);

    observer.onEvent("persistence_succeeded");

    expect(writeLine).toHaveBeenCalledOnce();
    const line = writeLine.mock.calls[0]?.[0];
    expect(line).toBeDefined();
    const record = JSON.parse(line!.trim()) as Record<string, unknown>;
    expect(record).toEqual({
      timestamp: expect.any(String),
      component: "web_session_refresh",
      event: "persistence_succeeded"
    });
    expect(Object.keys(record).sort()).toEqual(["component", "event", "timestamp"]);
    expect(record.timestamp).toMatch(/^\\d{4}-\\d{2}-\\d{2}T.*Z$/u);
  });

  it("does not add caller-controlled values to the record", () => {
    const lines: string[] = [];
    const observer = new StderrSessionRefreshObserver(line => lines.push(line));

    observer.onEvent("provider_failed");

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("session");
    expect(lines[0]).not.toContain("token");
    expect(lines[0]).not.toContain("provider response");
  });
});
