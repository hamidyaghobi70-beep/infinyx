exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE user_account_recovery_transactions (
      transaction_id uuid NOT NULL DEFAULT gen_random_uuid(),
      state_hash bytea PRIMARY KEY CHECK (octet_length(state_hash) = 32),
      browser_binding_hash bytea NOT NULL CHECK (octet_length(browser_binding_hash) = 32),
      encrypted_payload bytea NOT NULL CHECK (octet_length(encrypted_payload) BETWEEN 29 AND 4125),
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      consumed_at timestamptz,
      CONSTRAINT user_account_recovery_transactions_id_unique UNIQUE (transaction_id),
      CONSTRAINT user_account_recovery_transactions_expiry_check
        CHECK (expires_at > created_at AND expires_at <= created_at + interval '5 minutes 5 seconds'),
      CONSTRAINT user_account_recovery_transactions_consumed_check
        CHECK (consumed_at IS NULL OR (consumed_at >= created_at AND consumed_at < expires_at))
    );

    CREATE INDEX user_account_recovery_transactions_expiry_idx
      ON user_account_recovery_transactions (expires_at);

    CREATE TABLE user_account_recovery_audit_events (
      event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid REFERENCES users (id) ON DELETE RESTRICT,
      identity_id uuid REFERENCES user_external_identities (identity_id) ON DELETE RESTRICT,
      outcome varchar(16) NOT NULL CHECK (outcome IN ('denied', 'succeeded')),
      reason_code varchar(64) NOT NULL
        CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
      correlation_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX user_account_recovery_audit_user_idx
      ON user_account_recovery_audit_events (user_id, created_at DESC)
      WHERE user_id IS NOT NULL;

    CREATE FUNCTION prevent_user_account_recovery_audit_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      RAISE EXCEPTION 'Account recovery audit events are append-only';
    END;
    $function$;

    CREATE TRIGGER user_account_recovery_audit_immutable
      BEFORE UPDATE OR DELETE ON user_account_recovery_audit_events
      FOR EACH ROW EXECUTE FUNCTION prevent_user_account_recovery_audit_mutation();

    CREATE OR REPLACE FUNCTION record_user_account_security_transition()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $function$
    DECLARE
      recorded_event_id uuid;
    BEGIN
      INSERT INTO public.user_account_security_events
        (user_id, from_status, to_status, actor_user_id, reason_code, correlation_id)
      VALUES (
        NEW.user_id,
        OLD.status,
        NEW.status,
        NEW.status_changed_by,
        NEW.status_change_reason,
        NEW.status_change_correlation_id
      )
      RETURNING event_id INTO recorded_event_id;

      -- Every account security transition is a session boundary, including
      -- suspended -> active recovery. A pre-existing pending request is reused.
      INSERT INTO public.user_account_session_revocation_outbox
        (user_id, account_security_event_id)
      VALUES (NEW.user_id, recorded_event_id)
      ON CONFLICT (user_id) WHERE completed_at IS NULL DO NOTHING;

      RETURN NEW;
    END;
    $function$;

    REVOKE ALL ON FUNCTION prevent_user_account_recovery_audit_mutation() FROM PUBLIC;
    REVOKE ALL ON FUNCTION record_user_account_security_transition() FROM PUBLIC;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DO $preflight$
    BEGIN
      IF EXISTS (SELECT 1 FROM user_account_recovery_transactions)
         OR EXISTS (SELECT 1 FROM user_account_recovery_audit_events) THEN
        RAISE EXCEPTION 'Refusing to remove account recovery transaction or audit history';
      END IF;
    END;
    $preflight$;

    CREATE OR REPLACE FUNCTION record_user_account_security_transition()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $function$
    DECLARE
      recorded_event_id uuid;
    BEGIN
      INSERT INTO public.user_account_security_events
        (user_id, from_status, to_status, actor_user_id, reason_code, correlation_id)
      VALUES (
        NEW.user_id,
        OLD.status,
        NEW.status,
        NEW.status_changed_by,
        NEW.status_change_reason,
        NEW.status_change_correlation_id
      )
      RETURNING event_id INTO recorded_event_id;

      IF NEW.status IN ('suspended', 'disabled') THEN
        INSERT INTO public.user_account_session_revocation_outbox
          (user_id, account_security_event_id)
        VALUES (NEW.user_id, recorded_event_id)
        ON CONFLICT (user_id) WHERE completed_at IS NULL DO NOTHING;
      END IF;
      RETURN NEW;
    END;
    $function$;

    DROP TRIGGER user_account_recovery_audit_immutable ON user_account_recovery_audit_events;
    DROP FUNCTION prevent_user_account_recovery_audit_mutation();
    DROP TABLE user_account_recovery_audit_events;
    DROP TABLE user_account_recovery_transactions;
  `);
};
