exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE user_account_session_revocation_outbox (
      outbox_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
      account_security_event_id uuid NOT NULL UNIQUE
        REFERENCES user_account_security_events (event_id) ON DELETE RESTRICT,
      requested_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz,
      attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      last_error_code varchar(64),
      CONSTRAINT user_account_session_revocation_completion_check
        CHECK (completed_at IS NULL OR completed_at >= requested_at),
      CONSTRAINT user_account_session_revocation_error_check
        CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z][a-z0-9_]{0,63}$')
    );

    CREATE UNIQUE INDEX user_account_session_revocation_one_pending_user_idx
      ON user_account_session_revocation_outbox (user_id)
      WHERE completed_at IS NULL;

    CREATE INDEX user_account_session_revocation_pending_idx
      ON user_account_session_revocation_outbox (requested_at)
      WHERE completed_at IS NULL;

    CREATE FUNCTION guard_user_account_session_revocation_outbox_update()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF NEW.outbox_id IS DISTINCT FROM OLD.outbox_id
         OR NEW.user_id IS DISTINCT FROM OLD.user_id
         OR NEW.account_security_event_id IS DISTINCT FROM OLD.account_security_event_id
         OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
         OR NEW.attempts < OLD.attempts
         OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at) THEN
        RAISE EXCEPTION 'Invalid account session revocation outbox mutation';
      END IF;
      RETURN NEW;
    END;
    $function$;

    CREATE TRIGGER user_account_session_revocation_outbox_update_guard
      BEFORE UPDATE ON user_account_session_revocation_outbox
      FOR EACH ROW EXECUTE FUNCTION guard_user_account_session_revocation_outbox_update();

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

    REVOKE ALL ON FUNCTION guard_user_account_session_revocation_outbox_update() FROM PUBLIC;
    REVOKE ALL ON FUNCTION record_user_account_security_transition() FROM PUBLIC;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DO $preflight$
    BEGIN
      IF EXISTS (SELECT 1 FROM user_account_session_revocation_outbox) THEN
        RAISE EXCEPTION 'Refusing to remove account session revocation requests or history';
      END IF;
    END;
    $preflight$;

    CREATE OR REPLACE FUNCTION record_user_account_security_transition()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $function$
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
      );
      RETURN NEW;
    END;
    $function$;

    DROP TRIGGER user_account_session_revocation_outbox_update_guard
      ON user_account_session_revocation_outbox;
    DROP FUNCTION guard_user_account_session_revocation_outbox_update();
    DROP TABLE user_account_session_revocation_outbox;
  `);
};
