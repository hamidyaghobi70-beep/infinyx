# ADR-0001: Stage 4 persistent memory baseline

- Status: **Accepted as the engineering baseline; implementation and production use remain gated**
- Scope: Core Engine v1, single-tenant deployment with tenant-safe interfaces
- Date: 2026-11-23
- Owner authorization: Founder delegated the six Stage 4 technical choices to the engineering coordinator, prioritizing the simplest, fastest, maintainable secure option.

## Context

The existing `MemoryPort` is a storage boundary, not a persistence implementation. `GuardedMemoryPort` provides tenant-scoped addressing, default-deny policy checks, dedicated audit acknowledgement, input validation, and value isolation. It does not provide authenticated identity, durable storage, encryption, key custody, retention, backup, or durable audit.

A persistent adapter must not be connected until the composition root can bind `tenantId` and `actorId` to a trusted authenticated principal. Core v1 currently does not authenticate callers. No module may supply or select its own identity scope.

## Decisions

### D1 — Storage technology and hosting (M8/M10)

- Select **PostgreSQL** as the first durable backend.
- Use a managed PostgreSQL service for hosted environments; local development may use a local PostgreSQL instance or container.
- Keep the adapter behind the existing `MemoryPort`; do not leak SQL types or connection details into module APIs.
- Require TLS with certificate verification for remote database connections.
- Use parameterized queries, least-privilege database roles, schema migrations, connection limits, and bounded query timeouts.
- Keep tenant identity in the persistence model and enforce tenant scoping in the adapter as defense in depth; application-level `GuardedMemoryPort` remains mandatory.
- Do not add a database provider or connection string to the repository. Credentials are supplied by deployment secret management.

Rationale: PostgreSQL is mature, widely supported, open source, and avoids introducing a proprietary database dependency. A managed service reduces operational burden without changing the adapter contract.

### D2 — Encryption and key custody (M8/M9)

- Require TLS in transit and **application-layer envelope encryption** for persisted memory values.
- Use AES-256-GCM with a fresh cryptographically random nonce per value encryption; store algorithm and format versions with each ciphertext.
- Generate/use data-encryption keys through a cloud KMS or equivalent external key-management service. The database stores only ciphertext and non-secret key/version identifiers, never plaintext keys or KMS master keys.
- Keep a provider-neutral key-management interface so the deployment can select its KMS without changing `MemoryPort`.
- Rotate key-encryption keys through the KMS. Re-wrap data keys where supported; otherwise re-encrypt records through a bounded, resumable migration. Retain old key versions only for the documented migration/backup recovery window.
- If the KMS is unavailable, fail closed: do not write plaintext and do not silently fall back to a local or environment-stored production key.
- Local development may use an explicitly marked development-only key provider. It must be impossible to select that provider in production configuration.

Rationale: envelope encryption keeps key custody outside the database and supports key rotation without binding Core Engine to one cloud vendor.

### D3 — Retention, deletion, and backup (M10)

- Memory records receive an explicit `expiresAt`; default retention is **90 days**, configurable by deployment policy and overridable only by a stricter policy unless a documented legal hold applies.
- Expired records are eligible for scheduled hard deletion. User/tenant deletion requests initiate deletion from the primary database and enqueue backup-expiry tracking.
- Encrypted database backups are retained for **30 days** by default, with access restricted to recovery operators. A deleted record may remain in a backup until that backup expires; restore procedures must re-apply deletion records before the restored system accepts traffic.
- Do not implement indefinite retention, legal hold, or cross-region replication in v1.
- Do not store credentials, authentication secrets, payment-card data, government identifiers, or other restricted/high-risk secrets in memory.

Rationale: bounded retention limits exposure and operational cost. The backup restore rule prevents deleted data from silently reappearing after recovery.

### D4 — Durable audit (M11)

- Store audit records in a **separate PostgreSQL schema** from memory data, with separate database roles and credentials.
- The application writer role may INSERT only; it must not UPDATE or DELETE audit rows. Read access is limited to designated audit operators.
- Record actor, tenant, module, operation, resource identifiers, decision, reason code, timestamp, and outcome. Never record memory values, plaintext secrets, encryption keys, or raw credentials.
- Add append-only sequence metadata and a hash-chain/checkpoint design. Periodically export signed checkpoints to separately controlled immutable/object storage when the deployment provides it.
- Preserve the existing fail-closed rule: if the audit sink cannot acknowledge an allowed operation, the memory operation is refused.
- Treat a single database administrator as capable of bypassing database-local controls; do not describe this design as tamper-proof against privileged infrastructure operators.

Rationale: separate schema/roles are the smallest operational step that keeps audit capability distinct from module data. External immutable checkpoints provide stronger tamper evidence without requiring a second database product for v1.

### D5 — Versioned value envelope and migrations (M13)

- Wrap every persisted value in a versioned envelope containing at minimum: `formatVersion`, `schemaVersion`, `encryptionVersion`, `keyVersion`, `algorithm`, `nonce`, `ciphertext`, `authenticationTag`, `createdAt`, `updatedAt`, and `expiresAt`.
- Keep the serialized payload canonical JSON; never persist arbitrary executable objects.
- Migrations are forward-only, idempotent, bounded, observable, and resumable. Record migration version and progress; verify authentication tags before accepting decrypted content.
- Unknown future versions, invalid tags, malformed envelopes, and unsupported algorithms fail closed and are surfaced as generic storage errors without leaking ciphertext or key material.
- Preserve old readers only for the documented compatibility window; remove obsolete key/format support after backups using that format have expired.

Rationale: explicit format and key versions make encryption rotation and schema evolution independent and recoverable.

### D6 — Data classification (M12)

Use four classes:

| Class | Examples | v1 storage rule |
|---|---|---|
| Public | Public reference facts | Allowed |
| Internal | Non-sensitive application preferences and operational context | Allowed |
| Confidential | Personal or business context not intended for public disclosure | Allowed only when encrypted, tenant-scoped, access-controlled, and subject to retention |
| Restricted | Credentials, API keys, passwords, payment-card data, government identifiers, authentication factors, and similarly high-risk secrets | Prohibited from memory storage in v1 |

- Classification is explicit metadata on each record and is checked before write.
- Namespace and key names are operational identifiers, not secret containers; never put sensitive content in them.
- Audit records contain identifiers and decisions only, not values.
- If classification is missing or unknown, treat the record as Restricted and deny the write.

Rationale: default-deny classification prevents unlabelled or high-risk data from entering the memory system.

## Implementation gates (not waived by this ADR)

These decisions do **not** authorize connecting persistence to a live runtime or storing real user data.

1. Implement and test the PostgreSQL adapter, migrations, tenant isolation, transaction behavior, expiry, and restore-time deletion replay.
2. Implement the KMS abstraction and AES-256-GCM envelope; verify key rotation and KMS outage fail-closed behavior.
3. Implement durable audit writer, role grants, append-only enforcement, and external checkpoint export.
4. Implement classification enforcement and explicit expiry.
5. Provide an authenticated composition root that derives tenant and actor identity from a trusted principal. Until then, persistent memory composition must remain disabled.
6. Add integration tests using an isolated PostgreSQL service and test KMS; run the full CI matrix against the exact commit.
7. Complete independent review before any merge consideration.

## Explicit non-goals

- No production database, cloud account, KMS, credentials, or hosting service is provisioned by this ADR.
- No production connection string or secret is committed.
- No production deployment, release, merge, or runtime activation is authorized.
- Agent runtime remains OFF; Phase 0 remains NOT GRANTED.
- PR #60 remains untouched. PR #61 remains Draft and unmerged.

## Consequences

The choices settle the six owner-level design questions and provide a concrete implementation target. The durable adapter and security controls remain unimplemented until the gates above are satisfied. The existing in-memory reference store remains the only active storage implementation in Core Engine v1.
