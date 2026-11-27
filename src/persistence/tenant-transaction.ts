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

export interface TenantTransactionContext {
  readonly tenantId: string;
  readonly userId: string;
  readonly membershipId: string;
  readonly role: "owner" | "admin" | "manager" | "editor" | "viewer";
  readonly generation: number;
  readonly membershipVersion: string;
}

const tenantContexts = new WeakMap<object, TenantTransactionContext>();

export class TenantAuthorizationError extends Error {
  constructor() {
    super("Tenant authorization failed.");
    this.name = "TenantAuthorizationError";
  }
}

export function getTenantTransactionContext(
  transaction: TenantTransaction,
  principal?: AuthenticatedPrincipal
): TenantTransactionContext {
  const context = tenantContexts.get(transaction as object);
  if (!context || (principal && (
    !isAuthenticatedPrincipal(principal) || principal.userId !== context.userId
  ))) {
    throw new TenantAuthorizationError();
  }
  return context;
}

/** Tenant/business/project memory scope can be derived only inside an authorized transaction. */
export function createTenantMemoryScope(
  transaction: TenantTransaction,
  principal: AuthenticatedPrincipal,
  moduleId: string
) {
  const context = getTenantTransactionContext(transaction, principal);
  if (typeof moduleId !== "string" || moduleId.trim().length === 0 ||
      moduleId.length > 128 || /[\\u0000-\\u001f\\u007f-\\u009f]/u.test(moduleId)) {
    throw new AuthenticationError();
  }
  return Object.freeze({
    scope: "tenant" as const,
    tenantId: context.tenantId,
    userId: context.userId,
    membershipId: context.membershipId,
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
 * Selects a tenant independently from authentication, establishes RLS context,
 * and proves an active membership for the internal user before invoking work.
 */
export async function withTenantTransaction<Result>(
  pool: TenantSqlPool,
  principal: AuthenticatedPrincipal,
  tenantId: string,
  work: (transaction: TenantTransaction) => Promise<Result>
): Promise<Result> {
  if (!isAuthenticatedPrincipal(principal)) throw new AuthenticationError();
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
  let tenantTransaction: TenantTransaction | undefined;

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
    await controlQuery("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);

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

    transactionActive = true;
    tenantTransaction = Object.freeze({
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
    tenantContexts.set(tenantTransaction as object, Object.freeze({
      tenantId,
      userId: principal.userId,
      membershipId: membership.membership_id,
      role: membership.role as TenantTransactionContext["role"],
      generation: membership.generation,
      membershipVersion: String(membership.version)
    }));

    const result = await work(tenantTransaction);
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
    if (tenantTransaction) tenantContexts.delete(tenantTransaction as object);
    try {
      client.release(destroyClient);
    } catch {
      // Preserve the original transaction result.
    }
  }
}

/**
 * Invitation acceptance is the only tenant entry path without pre-existing
 * membership. The tenant is resolved from the token hash, never client input.
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
    if (!tenantId || tenantId.length > 256) throw new TenantPersistenceError();

    await controlQuery("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
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
