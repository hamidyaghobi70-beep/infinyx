import { X509Certificate } from "node:crypto";
import { isIP } from "node:net";
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

function readStrictTlsConfiguration(
  env: PostgresEnvironment,
  connectionHostname: string
): NonNullable<PoolConfig["ssl"]> {
  const ca = env.DATABASE_SSL_CA;
  const servername = env.DATABASE_SSL_SERVERNAME;

  if (
    !ca ||
    ca.length > 64 * 1024 ||
    !servername ||
    servername.length > 253 ||
    isIP(servername) !== 0 ||
    (isIP(connectionHostname) === 0 && servername.toLowerCase() !== connectionHostname.toLowerCase()) ||
    !/^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(?:\.(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?))*$/.test(servername)
  ) {
    throw new PostgresConfigurationError();
  }

  try {
    const certificate = new X509Certificate(ca);
    if (!certificate.ca) throw new PostgresConfigurationError();
  } catch {
    throw new PostgresConfigurationError();
  }

  // The explicit servername is intentionally independent of the network host:
  // private endpoints may be addressed by an IP while the certificate identity
  // is a DNS SAN. The caller must provide the expected DNS identity explicitly.
  return { rejectUnauthorized: true, ca, servername };
}

/**
 * Builds a safe, non-secret pool configuration.
 * TLS is mandatory outside local development/test and requires an explicit CA
 * and DNS server identity. SSL query parameters are rejected because
 * pg-connection-string can replace the separately supplied TLS options.
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

  // Reject all SSL URL parameters (case-insensitive) so URL parsing cannot
  // silently replace the application-owned TLS policy object.
  if ([...parsedUrl.searchParams.keys()].some((key) => key.toLowerCase().startsWith("ssl"))) {
    throw new PostgresConfigurationError();
  }

  const sslMode = env.DATABASE_SSL ?? "require";
  if (sslMode !== "require" && sslMode !== "disable") {
    throw new PostgresConfigurationError();
  }

  const nodeEnvironment = env.NODE_ENV ?? process.env.NODE_ENV;
  const isLoopbackDatabase =
    parsedUrl.hostname === "localhost" ||
    (isIP(parsedUrl.hostname) === 4 && parsedUrl.hostname.startsWith("127."));

  if (
    sslMode === "disable" &&
    nodeEnvironment !== "test" &&
    !(nodeEnvironment === "development" && isLoopbackDatabase)
  ) {
    throw new PostgresConfigurationError();
  }

  // Session refresh holds one checked-out client while the OIDC provider is
  // contacted (bounded to five seconds). The default remains conservative;
  // operators should size max from measured peak concurrent DB work, not from
  // request rate alone. Budget the sum of pool maxima across every application
  // replica and other DB consumers against the database connection limit, with
  // headroom for migrations/operations. Monitor pg.Pool waitingCount,
  // totalCount, and idleCount; a rising waitingCount signals pool pressure.
  // Increasing max without database capacity and load testing is not a fix.
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
    ssl:
      sslMode === "require"
        ? readStrictTlsConfiguration(env, parsedUrl.hostname)
        : false
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
    const result = await this.client.query(sql, [...values]);
    return {
      rows: result.rows as unknown as readonly Row[],
      rowCount: result.rowCount
    };
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
