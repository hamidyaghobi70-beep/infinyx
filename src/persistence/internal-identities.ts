export interface IdentityTransaction {
  query<Row = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[]
  ): Promise<readonly Row[]>;
}

export interface InternalUser {
  readonly id: string;
  readonly createdAt: string;
}

export interface ExternalIdentity {
  readonly identityId: string;
  readonly userId: string;
  readonly issuer: string;
  readonly subject: string;
  readonly createdAt: string;
}

export type ExternalIdentityLinkResult =
  | { readonly outcome: "linked"; readonly identity: ExternalIdentity }
  | { readonly outcome: "already_linked"; readonly identity: ExternalIdentity };

export class ExternalIdentityConflictError extends Error {
  constructor() {
    super("External identity is already linked");
    this.name = "ExternalIdentityConflictError";
  }
}

export class InternalIdentityPersistenceError extends Error {
  constructor() {
    super("Internal identity operation failed");
    this.name = "InternalIdentityPersistenceError";
  }
}

interface UserRow {
  id: string;
  created_at: string;
}

interface ExternalIdentityRow {
  identity_id: string;
  user_id: string;
  issuer: string;
  subject: string;
  created_at: string;
}

function validateIssuerAndSubject(issuer: string, subject: string): void {
  if (
    typeof issuer !== "string" ||
    issuer.length < 1 ||
    issuer.length > 2048 ||
    issuer !== issuer.trim() ||
    typeof subject !== "string" ||
    subject.length < 1 ||
    subject.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(subject)
  ) {
    throw new TypeError("Invalid external identity");
  }

  let parsed: URL;
  try {
    parsed = new URL(issuer);
  } catch {
    throw new TypeError("Invalid external identity");
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new TypeError("Invalid external identity");
  }
}

function toUser(row: UserRow): InternalUser {
  return Object.freeze({ id: row.id, createdAt: row.created_at });
}

function toExternalIdentity(row: ExternalIdentityRow): ExternalIdentity {
  return Object.freeze({
    identityId: row.identity_id,
    userId: row.user_id,
    issuer: row.issuer,
    subject: row.subject,
    createdAt: row.created_at
  });
}

/**
 * Creates an internal INFINYX user. Callers must use the same transaction
 * when they also establish a verified external identity link.
 */
export async function createInternalUser(
  transaction: IdentityTransaction
): Promise<InternalUser> {
  try {
    const rows = await transaction.query<UserRow>(
      `INSERT INTO users DEFAULT VALUES
       RETURNING id::text AS id, created_at::text AS created_at`
    );
    if (!rows[0]) throw new InternalIdentityPersistenceError();
    return toUser(rows[0]);
  } catch {
    throw new InternalIdentityPersistenceError();
  }
}

export async function getInternalUser(
  transaction: IdentityTransaction,
  userId: string
): Promise<InternalUser | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(userId)) {
    return null;
  }

  try {
    const rows = await transaction.query<UserRow>(
      `SELECT id::text AS id, created_at::text AS created_at
         FROM users
        WHERE id = $1::uuid
        LIMIT 1`,
      [userId]
    );
    return rows[0] ? toUser(rows[0]) : null;
  } catch {
    throw new InternalIdentityPersistenceError();
  }
}

/**
 * Links an already-verified provider identity to an internal user.
 * The caller is responsible for proving control of the external identity.
 * This function never links by email/phone equality and never reassigns a link.
 */
export async function linkExternalIdentity(
  transaction: IdentityTransaction,
  userId: string,
  issuer: string,
  subject: string
): Promise<ExternalIdentityLinkResult> {
  validateIssuerAndSubject(issuer, subject);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(userId)) {
    throw new TypeError("Invalid internal user identifier");
  }

  try {
    const inserted = await transaction.query<ExternalIdentityRow>(
      `INSERT INTO user_external_identities (user_id, issuer, subject)
       VALUES ($1::uuid, $2, $3)
       ON CONFLICT (issuer, subject) DO NOTHING
       RETURNING identity_id::text AS identity_id, user_id::text AS user_id,
                 issuer, subject, created_at::text AS created_at`,
      [userId, issuer, subject]
    );

    if (inserted[0]) {
      return Object.freeze({
        outcome: "linked",
        identity: toExternalIdentity(inserted[0])
      });
    }

    const existing = await transaction.query<ExternalIdentityRow>(
      `SELECT i.identity_id::text AS identity_id, i.user_id::text AS user_id,
              i.issuer, i.subject, i.created_at::text AS created_at
         FROM user_external_identities AS i
         INNER JOIN user_external_identity_lifecycle AS lifecycle
           ON lifecycle.identity_id = i.identity_id
          AND lifecycle.status = 'active'
        WHERE i.issuer = $1 AND i.subject = $2
        LIMIT 1`,
      [issuer, subject]
    );

    if (!existing[0]) throw new InternalIdentityPersistenceError();
    if (existing[0].user_id !== userId) throw new ExternalIdentityConflictError();

    return Object.freeze({
      outcome: "already_linked",
      identity: toExternalIdentity(existing[0])
    });
  } catch (error) {
    if (error instanceof ExternalIdentityConflictError) throw error;
    if (error instanceof TypeError) throw error;
    throw new InternalIdentityPersistenceError();
  }
}

export async function resolveExternalIdentity(
  transaction: IdentityTransaction,
  issuer: string,
  subject: string
): Promise<ExternalIdentity | null> {
  validateIssuerAndSubject(issuer, subject);

  try {
    const rows = await transaction.query<ExternalIdentityRow>(
      `SELECT identity_id::text AS identity_id, user_id::text AS user_id,
              issuer, subject, created_at::text AS created_at
         FROM user_external_identities
        WHERE issuer = $1 AND subject = $2
        LIMIT 1`,
      [issuer, subject]
    );
    return rows[0] ? toExternalIdentity(rows[0]) : null;
  } catch {
    throw new InternalIdentityPersistenceError();
  }
}
