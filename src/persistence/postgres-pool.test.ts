import { describe, expect, it } from "vitest";
import {
  buildPostgresPoolConfig,
  PostgresConfigurationError
} from "./postgres-pool.js";

const databaseUrl = "postgresql://infinyx_app:secret@example.test:5432/infinyx";

describe("buildPostgresPoolConfig", () => {
  it("requires a PostgreSQL connection URL", () => {
    expect(() => buildPostgresPoolConfig({})).toThrow(
      PostgresConfigurationError
    );
    expect(() =>
      buildPostgresPoolConfig({ DATABASE_URL: "https://example.test/db" })
    ).toThrow(PostgresConfigurationError);
  });

  it("requires TLS by default and verifies the server certificate", () => {
    const config = buildPostgresPoolConfig({ DATABASE_URL: databaseUrl });
    expect(config.ssl).toEqual({ rejectUnauthorized: true });
    expect(config.application_name).toBe("infinyx-api");
  });

  it("allows explicit TLS opt-out for local and ephemeral test databases", () => {
    const config = buildPostgresPoolConfig({
      DATABASE_URL: databaseUrl,
      DATABASE_SSL: "disable"
    });
    expect(config.ssl).toBe(false);
  });

  it("uses bounded pool and timeout defaults", () => {
    const config = buildPostgresPoolConfig({ DATABASE_URL: databaseUrl });
    expect(config.max).toBe(5);
    expect(config.connectionTimeoutMillis).toBe(5000);
    expect(config.idleTimeoutMillis).toBe(10000);
    expect(config.statement_timeout).toBe(10000);
  });

  it("accepts safe overrides within documented limits", () => {
    const config = buildPostgresPoolConfig({
      DATABASE_URL: databaseUrl,
      DATABASE_POOL_MAX: "12",
      DATABASE_CONNECTION_TIMEOUT_MS: "8000",
      DATABASE_IDLE_TIMEOUT_MS: "20000",
      DATABASE_STATEMENT_TIMEOUT_MS: "15000"
    });
    expect(config.max).toBe(12);
    expect(config.connectionTimeoutMillis).toBe(8000);
    expect(config.idleTimeoutMillis).toBe(20000);
    expect(config.statement_timeout).toBe(15000);
  });

  it.each([
    ["DATABASE_POOL_MAX", "0"],
    ["DATABASE_POOL_MAX", "21"],
    ["DATABASE_CONNECTION_TIMEOUT_MS", "999"],
    ["DATABASE_IDLE_TIMEOUT_MS", "60001"],
    ["DATABASE_STATEMENT_TIMEOUT_MS", "not-a-number"],
    ["DATABASE_SSL", "prefer"]
  ])("rejects unsafe %s=%s configuration", (key, value) => {
    expect(() =>
      buildPostgresPoolConfig({
        DATABASE_URL: databaseUrl,
        [key]: value
      })
    ).toThrow(PostgresConfigurationError);
  });

  it("does not include connection credentials in configuration errors", () => {
    let thrown: unknown;
    try {
      buildPostgresPoolConfig({
        DATABASE_URL: "postgresql://secret:password@/",
        DATABASE_POOL_MAX: "999"
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PostgresConfigurationError);
    expect((thrown as Error).message).not.toContain("secret");
    expect((thrown as Error).message).not.toContain("password");
  });
});
