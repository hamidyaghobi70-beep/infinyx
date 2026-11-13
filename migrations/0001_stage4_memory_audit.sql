-- Stage 4 append-only memory audit schema.
-- Apply with a dedicated migration role; the runtime role must not UPDATE or DELETE.

CREATE TABLE IF NOT EXISTS memory_audit_operations (
  operation_id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  module_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('read', 'write', 'delete')),
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
  reason TEXT NOT NULL,
  payload_hash BYTEA NOT NULL CHECK (octet_length(payload_hash) = 32),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS memory_audit_outcomes (
  operation_id UUID NOT NULL REFERENCES memory_audit_operations(operation_id),
  event_id UUID NOT NULL UNIQUE,
  sequence BIGINT NOT NULL CHECK (sequence > 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('DECISION_RECORDED', 'EFFECT_SUCCEEDED', 'EFFECT_FAILED', 'UNRESOLVED')),
  details_code TEXT NULL CHECK (details_code IS NULL OR length(details_code) <= 96),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (operation_id, sequence)
);

CREATE INDEX IF NOT EXISTS memory_audit_operations_recorded_at_idx
  ON memory_audit_operations (recorded_at, operation_id);

CREATE INDEX IF NOT EXISTS memory_audit_unresolved_idx
  ON memory_audit_outcomes (operation_id, sequence DESC);
