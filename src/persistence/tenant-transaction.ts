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

export interface TenantPrincipal extends AuthenticatedPrincipal {
  readonly tenantId: string;
  readonly membershipId: string;
  readonly role: "owner" | "admin" | "manager" | "editor" | "viewer";
  readonly generation: number;
  readonly membershipVersion: string;
}

const tenantPrincipals = new WeakSet<object>();

export class TenantAuthorizationError extends Error {
  constructor() {
    super("Tenant authorization failed.");
    this.name = "TenantAuthorizationError";
  }
}

export function isTenantPrincipal(value: unknown): value is TenantPrincipal {
  return !!value && typeof value === "object" && tenantPrincipals.has(value);
}

export function createTenantMemoryScope(principal: TenantPrincipal, moduleId: string) {
  if (!isTenantPrincipal(principal) || typeof moduleId !== "string" ||
      moduleId.trim().length === 0 || moduleId.length > 128 ||
      /[\\u0000-\\u001f\\u007f-\\u009f]/u.test(moduleId)) {
    throw new AuthenticationError();
  }
  return Object.freeze({
    scope: "tenant" as const,
    tenantId: principal.tenantId,
    userId: principal.userId,
    membershipId: principal.membershipId,
    moduleId
  });
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
  tenantId: string,
  work: (transaction: TenantTransaction, tenantPrincipal: TenantPrincipal) => Promise<Result>
): Promise<Result> {
  if (!isAuthenticatedPrincipal(principal)) {
    throw new AuthenticationError();
  }
  if (typeof tenantId !== "string" || tenantId.trim().length === 0 ||
      tenantId.length > 256 || /[\\u0000-\\u001f\\u007f-\\u009f]/u.test(tenantId)) {
    throw new TenantAuthorizationError();
  }

  let client: TenantSqlClient;
  try {
    client = await pool.connect();
  } catch {
    throw new TenantPersistenceError();
  }

  let transactionOpen = false;
  let transactionActive = false;
  let transactionFailed = false;
  let destroyClient = false;
  const controlQuery = async (sql: string, values?: readonly unknown[]) => {
    try {
      await client.query(sql, values);
    } catch {
      transactionFailed = true;
      if (sql === "BEGIN") {
        destroyClient = true;
      }
      throw new TenantPersistenceError();
    }
  };

  try {
    await controlQuery("BEGIN");
    transactionOpen = true;
    await controlQuery(
      "SELECT set_config('app.tenant_id', $1, true)",
      [tenantId]
    );

    let membership: {
      membership_id: string;
      role: string;
      generation: number;
      version: string | number;
    } | undefined;
    try {
      const result = await client.query<{
        membership_id: string;
        role: string;
        generation: number;
        version: string | number;
      }>(
        `SELECT membership_id::text AS membership_id, role, generation, version
           FROM tenant_memberships
          WHERE tenant_id = $1
            AND internal_user_id = $2::uuid
            AND status = 'active'
          ORDER BY generation DESC
          LIMIT 1`,
        [tenantId, principal.userId]
      );
      membership = result.rows[0];
    } catch {
      transactionFailed = true;
      throw new TenantPersistenceError();
    }
    if (!membership ||
        !["owner", "admin", "manager", "editor", "viewer"].includes(membership.role) ||
        !Number.isSafeInteger(membership.generation) ||
        membership.generation < 1) {
      throw new TenantAuthorizationError();
    }

    const tenantPrincipal = Object.freeze({
      ...principal,
      tenantId,
      membershipId: membership.membership_id,
      role: membership.role as TenantPrincipal["role"],
      generation: membership.generation,
      membershipVersion: String(membership.version)
    });
    tenantPrincipals.add(tenantPrincipal);

    transactionActive = true;
    const transaction: TenantTransaction = Object.freeze({
      query: async <Row = Record<string, unknown>>(
        sql: string,
        values: readonly unknown[] = []
      ): Promise<readonly Row[]> => {
        if (!transactionActive) {
          throw new TenantPersistenceError();
        }
        try {
          const result = await client.query<Row>(sql, values);
          return result.rows;
        } catch {
          transactionFailed = true;
          throw new TenantPersistenceError();
        }
      }
    });

    const result = await work(transaction, tenantPrincipal);
    transactionActive = false;
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
    transactionActive = false;
    try {
      client.release(destroyClient);
    } catch {
      // A release failure must not replace the operation's original outcome.
    }
  }
}


/**
 * Opens a transaction for an invitation only after the database's narrowly
 * privileged token-hash lookup resolves its tenant. The caller cannot supply
 * a tenant ID. The lookup function must be owned by a dedicated, reviewed
 * BYPASSRLS role in production; the ordinary app role receives EXECUTE only.
 */
export async function withInvitationTenantTransaction<Result>(
  pool: TenantSqlPool,
  principal: AuthenticatedPrincipal,
  tokenHash: Buffer,
  work: (transaction: TenantTransaction, tenantId: string) => Promise<Result>
): Promise<Result> {
  if (!isAuthenticatedPrincipal(principal) ||
      !Buffer.isBuffer(tokenHash) || tokenHash.length !== 32) {
    throw new AuthenticationError();
  }

  let client: TenantSqlClient;
  try {
    client = await pool.connect();
  } catch {
    throw new TenantPersistenceError();
  }

  let transactionOpen = false;
  let transactionActive = false;
  let transactionFailed = false;
  let destroyClient = false;
  const controlQuery = async (sql: string, values?: readonly unknown[]) => {
    try {
      await client.query(sql, values);
    } catch {
      transactionFailed = true;
      if (sql === "BEGIN") destroyClient = true;
      throw new TenantPersistenceError();
    }
  };

  try {
    await controlQuery("BEGIN");
    transactionOpen = true;

    let tenantId: string | null = null;
    try {
      const lookup = await client.query<{ tenant_id: string }>(
        "SELECT lookup_tenant_for_invitation_token($1) AS tenant_id",
        [tokenHash]
      );
      tenantId = lookup.rows[0]?.tenant_id ?? null;
    } catch {
      transactionFailed = true;
      throw new TenantPersistenceError();
    }
    if (!tenantId || tenantId.length > 256) {
      throw new TenantPersistenceError();
    }

    await controlQuery(
      "SELECT set_config('app.tenant_id', $1, true)",
      [tenantId]
    );

    transactionActive = true;
    const transaction: TenantTransaction = Object.freeze({
      query: async <Row = Record<string, unknown>>(
        sql: string,
        values: readonly unknown[] = []
      ): Promise<readonly Row[]> => {
        if (!transactionActive) throw new TenantPersistenceError();
        try {
          const result = await client.query<Row>(sql, values);
          return result.rows;
        } catch {
          transactionFailed = true;
          throw new TenantPersistenceError();
        }
      }
    });

    const result = await work(transaction, tenantId);
    transactionActive = false;
    if (transactionFailed) throw new TenantPersistenceError();
    await controlQuery("COMMIT");
    transactionOpen = false;
    return result;
  } catch (error) {
    transactionActive = false;
    if (transactionOpen) {
      try {
        await client.query("ROLLBACK");
      } catch {
        destroyClient = true;
      }
    }
    throw error;
  } finally {
    transactionActive = false;
    try {
      client.release(destroyClient);
    } catch {
      // Preserve the original transaction result.
    }
  }
}
