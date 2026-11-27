import {
  AuthenticationError,
  isAuthenticatedPrincipal,
  type AuthenticatedPrincipal
} from "../core/authenticated-principal.js";

export interface SqlQueryResult<Row> {
  readonly rows: readonly Row[];
  readonly rowCount: number | null;
}

export interface TenantSqlClient {
  query<Row = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[]
  ): Promise<SqlQueryResult<Row>>;
  release(destroy?: boolean): void;
}

export interface TenantSqlPool {
  connect(): Promise<TenantSqlClient>;
}

export interface TenantTransaction {
  query<Row = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[]
  ): Promise<readonly Row[]>;
}

export class TenantPersistenceError extends Error {
  constructor() {
    super("Tenant persistence operation failed.");
    this.name = "TenantPersistenceError";
  }
}

/**
 * Runs trusted repository work in a transaction bound to a verified principal.
 * The callback must contain application-owned SQL only; never pass client input
 * as SQL text. All values must be supplied through the parameter array.
 *
 * This is a transaction-context primitive, not proof of RLS isolation.
 */
export async function withTenantTransaction<Result>(
  pool: TenantSqlPool,
  principal: AuthenticatedPrincipal,
  work: (transaction: TenantTransaction) => Promise<Result>
): Promise<Result> {
  if (!isAuthenticatedPrincipal(principal)) {
    throw new AuthenticationError();
  }

  let client: TenantSqlClient;
  try {
    client = await pool.connect();
  } catch {
    throw new TenantPersistenceError();
  }

  let transactionOpen = false;
  let transactionFailed = false;
  let destroyClient = false;
  const controlQuery = async (sql: string, values?: readonly unknown[]) => {
    try {
      await client.query(sql, values);
    } catch {
      transactionFailed = true;
      throw new TenantPersistenceError();
    }
  };

  try {
    await controlQuery("BEGIN");
    transactionOpen = true;
    await controlQuery(
      "SELECT set_config('app.tenant_id', $1, true)",
      [principal.tenantId]
    );

    const transaction: TenantTransaction = Object.freeze({
      query: async <Row = Record<string, unknown>>(
        sql: string,
        values: readonly unknown[] = []
      ): Promise<readonly Row[]> => {
        try {
          const result = await client.query<Row>(sql, values);
          return result.rows;
        } catch {
          transactionFailed = true;
          throw new TenantPersistenceError();
        }
      }
    });

    const result = await work(transaction);
    if (transactionFailed) {
      throw new TenantPersistenceError();
    }
    await controlQuery("COMMIT");
    transactionOpen = false;
    return result;
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Do not return a connection with uncertain transaction state to the pool.
        destroyClient = true;
      }
    }
    throw error;
  } finally {
    try {
      client.release(destroyClient);
    } catch {
      // A release failure must not replace the operation's original outcome.
    }
  }
}
