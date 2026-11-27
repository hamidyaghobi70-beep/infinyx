import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { PostgresWebSessionStore } from "./session-store.js";
import {
  completeAccountSessionRevocation,
  retryPendingAccountSessionRevocations
} from "./account-session-revocation.js";

const userId = "10000000-0000-4000-8000-000000000001";
const outboxId = "20000000-0000-4000-8000-000000000001";

describe("account session revocation outbox", () => {
  it("completes only after all of the user's sessions are revoked", async () => {
    const calls: string[] = [];
    const pool = {
      query: vi.fn(async (sql: string) => {
        calls.push(sql);
        return { rows: [], rowCount: 1 };
      })
    } as unknown as Pool;
    const sessions = {
      revokeAllForUser: vi.fn(async () => { calls.push("sessions-revoked"); })
    } as unknown as PostgresWebSessionStore;

    await expect(completeAccountSessionRevocation(pool, sessions, userId, outboxId))
      .resolves.toBe(true);
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith(userId);
    expect(calls[0]).toBe("sessions-revoked");
    expect(calls[1]).toContain("SET completed_at = now()");
  });

  it("leaves the fail-closed outbox pending when session revocation fails", async () => {
    const pool = {
      query: vi.fn(async () => ({ rows: [], rowCount: 1 }))
    } as unknown as Pool;
    const sessions = {
      revokeAllForUser: vi.fn(async () => { throw new Error("database unavailable"); })
    } as unknown as PostgresWebSessionStore;

    await expect(completeAccountSessionRevocation(pool, sessions, userId, outboxId))
      .resolves.toBe(false);
    expect(pool.query).toHaveBeenCalledOnce();
    expect(vi.mocked(pool.query).mock.calls[0]?.[0]).toContain("session_revocation_failed");
  });

  it("retries pending requests and reports unresolved failures", async () => {
    const pool = {
      query: vi.fn(async (sql: string) => sql.includes("SELECT outbox_id")
        ? { rows: [{ outbox_id: outboxId, user_id: userId }], rowCount: 1 }
        : { rows: [], rowCount: 1 })
    } as unknown as Pool;
    const sessions = {
      revokeAllForUser: vi.fn(async () => undefined)
    } as unknown as PostgresWebSessionStore;

    await expect(retryPendingAccountSessionRevocations(pool, sessions)).resolves.toBe(0);
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith(userId);
  });
});
