-- PostgreSQL integration checks for the Stage 4 audit schema.
-- Runs against an isolated CI database; fixed IDs are safe because each job gets a fresh database.

DO $$
BEGIN
  IF to_regclass('public.memory_audit_operations') IS NULL
     OR to_regclass('public.memory_audit_outcomes') IS NULL THEN
    RAISE EXCEPTION 'Stage 4 audit migration did not create the expected tables';
  END IF;
END $$;

-- Decision row and its initial outcome are committed atomically by the adapter.
BEGIN;
INSERT INTO memory_audit_operations
  (operation_id, tenant_id, actor_id, module_id, operation, namespace, key, decision, reason, payload_hash)
VALUES
  ('10000000-0000-4000-8000-000000000001', 'tenant-ci', 'actor-ci', 'module-ci',
   'write', 'profile', 'display-name', 'allow', 'policy-allowed', decode(repeat('a', 64), 'hex'));
INSERT INTO memory_audit_outcomes (operation_id, event_id, sequence, outcome)
VALUES ('10000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000001', 1, 'DECISION_RECORDED');
COMMIT;

-- Idempotent operation identity: a duplicate key cannot create a second operation.
INSERT INTO memory_audit_operations
  (operation_id, tenant_id, actor_id, module_id, operation, namespace, key, decision, reason, payload_hash)
VALUES
  ('10000000-0000-4000-8000-000000000001', 'tenant-ci', 'actor-ci', 'module-ci',
   'write', 'profile', 'display-name', 'allow', 'policy-allowed', decode(repeat('a', 64), 'hex'))
ON CONFLICT (operation_id) DO NOTHING;

DO $$
BEGIN
  IF (SELECT count(*) FROM memory_audit_operations
      WHERE operation_id = '10000000-0000-4000-8000-000000000001') <> 1 THEN
    RAISE EXCEPTION 'operation_id uniqueness/idempotent insert check failed';
  END IF;
  IF (SELECT count(*) FROM memory_audit_outcomes
      WHERE operation_id = '10000000-0000-4000-8000-000000000001') <> 1 THEN
    RAISE EXCEPTION 'initial decision outcome was not retained exactly once';
  END IF;
END $$;

-- Outcome identity and per-operation sequence are independently unique.
INSERT INTO memory_audit_outcomes (operation_id, event_id, sequence, outcome)
VALUES ('10000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000002', 2, 'EFFECT_SUCCEEDED');

DO $$
BEGIN
  BEGIN
    INSERT INTO memory_audit_outcomes (operation_id, event_id, sequence, outcome)
    VALUES ('10000000-0000-4000-8000-000000000001',
            '20000000-0000-4000-8000-000000000003', 2, 'EFFECT_FAILED');
    RAISE EXCEPTION 'duplicate per-operation sequence unexpectedly succeeded';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO memory_audit_outcomes (operation_id, event_id, sequence, outcome)
    VALUES ('10000000-0000-4000-8000-000000000001',
            '20000000-0000-4000-8000-000000000002', 3, 'EFFECT_FAILED');
    RAISE EXCEPTION 'duplicate event_id unexpectedly succeeded';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
END $$;

-- A transaction that loses its connection/rolls back must leave no partial row.
BEGIN;
INSERT INTO memory_audit_operations
  (operation_id, tenant_id, actor_id, module_id, operation, namespace, key, decision, reason, payload_hash)
VALUES
  ('10000000-0000-4000-8000-000000000099', 'tenant-ci', 'actor-ci', 'module-ci',
   'write', 'profile', 'rollback-check', 'allow', 'policy-allowed', decode(repeat('b', 64), 'hex'));
ROLLBACK;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM memory_audit_operations
             WHERE operation_id = '10000000-0000-4000-8000-000000000099') THEN
    RAISE EXCEPTION 'rollback left a partial operation row';
  END IF;
END $$;

-- Foreign-key integrity rejects outcomes without an operation.
DO $$
BEGIN
  BEGIN
    INSERT INTO memory_audit_outcomes (operation_id, event_id, sequence, outcome)
    VALUES ('10000000-0000-4000-8000-000000000098',
            '20000000-0000-4000-8000-000000000098', 1, 'DECISION_RECORDED');
    RAISE EXCEPTION 'orphan outcome unexpectedly succeeded';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
END $$;

SELECT 'Stage 4 PostgreSQL schema integration checks passed' AS result;
