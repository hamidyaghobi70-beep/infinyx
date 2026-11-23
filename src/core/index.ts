export { CoreEngine } from "./core-engine.js";
export type { CoreEngineOptions } from "./core-engine.js";
export { CoreError } from "./core-error.js";
export type { CoreErrorCode } from "./core-error.js";
export { DefaultDenyPolicyEngine } from "./default-policy-engine.js";
export { FailClosedPolicyEngine } from "./fail-closed-policy-engine.js";
export { InMemoryEventBus } from "./event-bus.js";
export {
  DEFAULT_MAX_MEMORY_VALUE_BYTES,
  GuardedMemoryPort,
  MEMORY_ACCESS_DECIDED_EVENT,
  MEMORY_ACCESS_FAILED_EVENT
} from "./guarded-memory-port.js";
export type {
  GuardedMemoryPortOptions,
  MemoryAuditPort,
  MemoryAccessDecidedEvent,
  MemoryAccessFailedEvent,
  MemoryOperation,
  MemoryScope
} from "./guarded-memory-port.js";
export { InMemoryMemoryStore } from "./in-memory-memory-store.js";
export { MemoryValueCipher, MemoryEncryptionError } from "./memory-encryption.js";
export type { MemoryKeyProvider, EncryptedMemoryEnvelope } from "./memory-encryption.js";
export { PostgresEncryptedMemoryStore } from "./postgres-memory-store.js";
export type { PostgresMemoryStoreOptions, StoredMemoryEnvelope, SqlExecutor, SqlQueryResult } from "./postgres-memory-store.js";
export { PostgresMemoryAuditPort } from "./postgres-memory-audit.js";
export type { AuditSqlConnection, AuditSqlPool } from "./postgres-memory-audit.js";
export { MemoryAccessError } from "./memory-error.js";
export type { MemoryErrorCode } from "./memory-error.js";
export { ModuleRegistry } from "./module-registry.js";
export { ProcessIsolatedPolicyEngine } from "./process-isolated-policy-engine.js";
export type { ProcessIsolatedPolicyEngineOptions, PolicyExecutionEvent } from "./process-isolated-policy-engine.js";
export type {
  CoreLifecycleState,
  CoreModule,
  EventBusPort,
  EventEnvelope,
  EventHandler,
  MemoryAddress,
  MemoryPort,
  ModuleContext,
  ModuleLifecycleState,
  PolicyDecision,
  PolicyEngine,
  PolicyEvaluationOptions,
  PolicyExecutionRecord,
  PolicyExecutionLifecycleState,
  PolicyStopReason,
  PolicyTerminalOutcome,
  PolicyCleanupStatus,
  PolicyRuntimeStatus,
  PolicyRequest,
  ProtectedOperationCaller,
  ProtectedOperationContext,
  ProtectedOperationDefinition,
  ProtectedOperationHandle,
  ProtectedOperationPort,
  ProtectedOperationResult
} from "./contracts.js";

export { PostgresMigrationRunner } from "./postgres-migration-runner.js";
export type { CoreMigration, MigrationPool, MigrationConnection, MigrationRunResult, MigrationQueryResult } from "./postgres-migration-runner.js";

export { MemoryDeletionCoordinator } from "./memory-deletion-replay.js";
export type { MemoryDeletionLedgerPort, MemoryDeletionTombstone, MemoryDeletionReplayOptions, MemoryDeletionReplayResult } from "./memory-deletion-replay.js";
