import { createBffHttpServer } from "./bff-server.js";
import {
  createOidcBffHandlers,
  discoverOidcClient,
  validateOidcBffConfiguration,
  type OidcBffConfiguration
} from "./oidc-bff.js";
import { decodeSessionEncryptionKey } from "./session-crypto.js";
import { PostgresOidcLoginTransactionStore } from "./oidc-login-transactions.js";
import { createPostgresPool } from "../persistence/postgres-pool.js";
import { PostgresWebSessionStore } from "./session-store.js";
import { PostgresIdentitySecurityTransactionStore } from "./identity-security-transactions.js";
import { createIdentityLinkHandlers } from "./identity-link-handlers.js";
import { retryPendingIdentitySessionRevocations } from "./identity-link-workflow.js";
import { retryPendingAccountSessionRevocations } from "./account-session-revocation.js";

export class WebBffStartupError extends Error {
  constructor() {
    super("INFINYX Web BFF startup failed.");
    this.name = "WebBffStartupError";
  }
}

export interface WebBffRuntimeConfiguration {
  readonly oidc: OidcBffConfiguration;
  readonly sessionEncryptionKey: Buffer;
  readonly host: string;
  readonly port: number;
}

export function readWebBffRuntimeConfiguration(
  env: Readonly<Record<string, string | undefined>>
): WebBffRuntimeConfiguration {
  try {
    const oidc: OidcBffConfiguration = {
      issuer: required(env.OIDC_ISSUER),
      clientId: required(env.OIDC_CLIENT_ID),
      clientSecret: required(env.OIDC_CLIENT_SECRET),
      redirectUri: required(env.OIDC_REDIRECT_URI),
      publicOrigin: required(env.PUBLIC_ORIGIN)
    };
    validateOidcBffConfiguration(oidc);
    const sessionEncryptionKey = decodeSessionEncryptionKey(env.SESSION_ENCRYPTION_KEY);
    const host = env.HOST ?? "0.0.0.0";
    if (host.length < 1 || host.length > 253 || /[\s\u0000-\u001f\u007f]/u.test(host)) {
      throw new WebBffStartupError();
    }
    const portText = env.PORT ?? "3000";
    if (!/^\d{1,5}$/u.test(portText)) throw new WebBffStartupError();
    const port = Number(portText);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new WebBffStartupError();
    }
    return Object.freeze({ oidc, sessionEncryptionKey, host, port });
  } catch {
    throw new WebBffStartupError();
  }
}

function required(value: string | undefined): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096) {
    throw new WebBffStartupError();
  }
  return value;
}

export async function createWebBffApplication(
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  const runtime = readWebBffRuntimeConfiguration(env);
  let pool: ReturnType<typeof createPostgresPool> | undefined;
  try {
    pool = createPostgresPool(env);
    const client = await discoverOidcClient(runtime.oidc);
    const sessions = new PostgresWebSessionStore(pool, runtime.sessionEncryptionKey);
    const loginTransactions = new PostgresOidcLoginTransactionStore(
      pool,
      runtime.sessionEncryptionKey
    );
    const securityTransactions = new PostgresIdentitySecurityTransactionStore(
      pool,
      runtime.sessionEncryptionKey
    );
    await retryPendingIdentitySessionRevocations(pool, sessions);
    await retryPendingAccountSessionRevocations(pool, sessions);
    const handlers = createOidcBffHandlers({
      configuration: runtime.oidc,
      client,
      database: pool,
      sessions,
      loginTransactions
    });
    const identityHandlers = createIdentityLinkHandlers({
      configuration: runtime.oidc,
      client,
      database: pool,
      sessions,
      securityTransactions
    });
    return Object.freeze({
      server: createBffHttpServer({ ...handlers, ...identityHandlers }),
      pool,
      retryPendingIdentitySessionRevocations: () => retryPendingIdentitySessionRevocations(pool!, sessions),
      retryPendingAccountSessionRevocations: () => retryPendingAccountSessionRevocations(pool!, sessions),
      host: runtime.host,
      port: runtime.port
    });
  } catch {
    if (pool) {
      try { await pool.end(); } catch { /* do not expose shutdown details */ }
    }
    throw new WebBffStartupError();
  }
}
