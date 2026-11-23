-- INFINYX Stage 4 baseline schema. Apply with a privileged migration role.
CREATE SCHEMA IF NOT EXISTS infinyx_memory;
CREATE TABLE IF NOT EXISTS infinyx_memory.memory_entries (
  tenant_id text NOT NULL,
  namespace text NOT NULL,
  memory_key text NOT NULL,
  envelope jsonb NOT NULL,
  classification text NOT NULL CHECK (classification IN ('public', 'internal', 'confidential')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, namespace, memory_key),
  CONSTRAINT memory_envelope_object CHECK (jsonb_typeof(envelope) = 'object')
);
CREATE INDEX IF NOT EXISTS memory_entries_expiry_idx
  ON infinyx_memory.memory_entries (expires_at);
CREATE INDEX IF NOT EXISTS memory_entries_tenant_expiry_idx
  ON infinyx_memory.memory_entries (tenant_id, expires_at);

CREATE SCHEMA IF NOT EXISTS infinyx_audit;
CREATE TABLE IF NOT EXISTS infinyx_audit.audit_chain_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  sequence bigint NOT NULL DEFAULT 0,
  head_hash text NOT NULL DEFAULT repeat('0', 64)
);
INSERT INTO infinyx_audit.audit_chain_state (singleton)
VALUES (true) ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS infinyx_audit.memory_access_events (
  sequence bigint PRIMARY KEY,
  event_type text NOT NULL CHECK (event_type IN ('decision', 'failure')),
  actor_id text NOT NULL,
  tenant_id text NOT NULL,
  module_id text NOT NULL,
  operation text NOT NULL,
  namespace text NOT NULL,
  memory_key text NOT NULL,
  decision text,
  reason_code text,
  error_name text,
  occurred_at timestamptz NOT NULL,
  previous_hash text NOT NULL,
  entry_hash text NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_access_events_tenant_time_idx
  ON infinyx_audit.memory_access_events (tenant_id, occurred_at DESC);

-- Provision roles and grants separately using deployment-specific role names.
-- The application writer should receive INSERT only on memory_access_events and no UPDATE/DELETE.
