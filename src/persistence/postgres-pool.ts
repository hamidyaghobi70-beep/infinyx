import { Pool, type PoolConfig } from "pg";
import type {
  SqlQueryResult,
  TenantSqlClient,
  TenantSqlPool
} from "./tenant-transaction.js";

export type PostgresEnvironment = Readonly<Record<string, string | undefined>>;

export class PostgresConfigurationError extends Error {
  constructor() {
    super("PostgreSQL configuration is invalid.");
    this.name = "PostgresConfigurationError";
  }
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) throw new PostgresConfigurationError();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new PostgresConfigurationError();
  }
  return parsed;
}

/**
 * Builds a safe, non-secret pool configuration. TLS is required by default;
 * local/test databases must opt out explicitly with DATABASE_SSL=disable.
 */
export function buildPostgresPoolConfig(
  env: PostgresEnvironment
): PoolConfig {
  const connectionString = env.DATABASE_URL;
  if (!connectionString || connectionString.length > 4096) {
    throw new PostgresConfigurationError();
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(connectionString);
  } catch {
    throw new PostgresConfigurationError();
  }

  if (
    !["postgres:", "postgresql:"].includes(parsedUrl.protocol) ||
    !parsedUrl.hostname ||
    !parsedUrl.username ||
    !parsedUrl.pathname ||
    parsedUrl.pathname === "/"
  ) {
    throw new PostgresConfigurationError();
  }

  const sslMode = env.DATABASE_SSL ?? "require";
  if (sslMode !== "require" && sslMode !== "disable") {
    throw new PostgresConfigurationError();
  }

  const config: PoolConfig = {
    connectionString,
    max: boundedInteger(env.DATABASE_POOL_MAX, 5, 1, 20),
    connectionTimeoutMillis: boundedInteger(
      env.DATABASE_CONNECTION_TIMEOUT_MS,
      5000,
      1000,
      30000
    ),
    idleTimeoutMillis: boundedInteger(
      env.DATABASE_IDLE_TIMEOUT_MS,
      10000,
      1000,
      60000
    ),
    statement_timeout: boundedInteger(
      env.DATABASE_STATEMENT_TIMEOUT_MS,
      10000,
      1000,
      30000
    ),
    application_name: "infinyx-api",
    ssl: sslMode === "require" ? { rejectUnauthorized: true } : false
  };

  return config;
}

class PgTenantSqlClient implements TenantSqlClient {
  constructor(
    private readonly client: import("pg").PoolClient
  ) {}

  async query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = []
  ): Promise<SqlQueryResult<Row>> {
    const result = await this.client.query<Row>(sql, [...values]);
    return { rows: result.rows, rowCount: result.rowCount };
  }

  release(destroy = false): void {
    this.client.release(
      destroy ? new Error("Discarding an uncertain PostgreSQL client.") : undefined
    );
  }
}

/** Adapts the real pg Pool to the restricted tenant transaction interface. */
export function createTenantSqlPool(pool: Pool): TenantSqlPool {
  return Object.freeze({
    connect: async (): Promise<TenantSqlClient> =>
      new PgTenantSqlClient(await pool.connect())
  });
}

/** Creates a pool; callers must call pool.end() during application shutdown. */
export function createPostgresPool(
  env: PostgresEnvironment = process.env
): Pool {
  return new Pool(buildPostgresPoolConfig(env));
}
