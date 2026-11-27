exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE;

    DO $preflight$
    BEGIN
      IF to_regclass('public.user_account_security') IS NOT NULL
         OR to_regclass('public.user_account_security_events') IS NOT NULL THEN
        RAISE EXCEPTION 'Account security tables already exist; refusing to adopt an unknown schema';
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'users'
           AND column_name = 'id' AND data_type = 'uuid'
      ) OR NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'users'
           AND column_name = 'created_at' AND data_type = 'timestamp with time zone'
      ) THEN
        RAISE EXCEPTION 'Expected internal users schema is missing or incompatible';
      END IF;
    END;
    $preflight$;

    CREATE TABLE user_account_security (
      user_id uuid PRIMARY KEY,
      status varchar(16) NOT NULL DEFAULT 'active',
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      status_changed_by uuid,
      status_change_reason varchar(64),
      status_change_correlation_id uuid,
      CONSTRAINT user_account_security_user_fk
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT,
      CONSTRAINT user_account_security_actor_fk
        FOREIGN KEY (status_changed_by) REFERENCES users (id) ON DELETE RESTRICT,
      CONSTRAINT user_account_security_status_check
        CHECK (status IN ('active', 'suspended', 'disabled')),
      CONSTRAINT user_account_security_version_check
        CHECK (version >= 1),
      CONSTRAINT user_account_security_reason_check
        CHECK (status_change_reason IS NULL OR status_change_reason ~ '^[a-z][a-z0-9_]{0,63}$'),
      CONSTRAINT user_account_security_initial_state_check
        CHECK (
          (version = 1 AND status = 'active' AND status_changed_by IS NULL
            AND status_change_reason IS NULL AND status_change_correlation_id IS NULL)
          OR
          (version > 1 AND status_change_reason IS NOT NULL
            AND status_change_correlation_id IS NOT NULL)
        )
    );

    CREATE TABLE user_account_security_events (
      event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL,
      from_status varchar(16),
      to_status varchar(16) NOT NULL,
      actor_user_id uuid,
      reason_code varchar(64) NOT NULL
        CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
      correlation_id uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT user_account_security_events_user_fk
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT,
      CONSTRAINT user_account_security_events_actor_fk
        FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE RESTRICT,
      CONSTRAINT user_account_security_events_from_status_check
        CHECK (from_status IS NULL OR from_status IN ('active', 'suspended', 'disabled')),
      CONSTRAINT user_account_security_events_to_status_check
        CHECK (to_status IN ('active', 'suspended', 'disabled'))
    );

    CREATE INDEX user_account_security_status_idx
      ON user_account_security (status, user_id);
    CREATE INDEX user_account_security_events_user_idx
      ON user_account_security_events (user_id, created_at DESC);

    CREATE FUNCTION enforce_user_account_security_update()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Account security state is retained';
      END IF;

      IF NEW.user_id IS DISTINCT FROM OLD.user_id
         OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Account security identity and creation time are immutable';
      END IF;

      IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
        RAISE EXCEPTION 'Account security records may change only through a status transition';
      END IF;

      IF OLD.status = 'disabled'
         OR NOT (
           (OLD.status = 'active' AND NEW.status IN ('suspended', 'disabled'))
           OR (OLD.status = 'suspended' AND NEW.status IN ('active', 'disabled'))
         ) THEN
        RAISE EXCEPTION 'Invalid account security status transition';
      END IF;

      IF NEW.version <> OLD.version + 1
         OR NEW.updated_at <= OLD.updated_at
         OR NEW.status_change_reason IS NULL
         OR NEW.status_change_correlation_id IS NULL THEN
        RAISE EXCEPTION 'Account security transition metadata is invalid';
      END IF;

      RETURN NEW;
    END;
    $function$;

    CREATE FUNCTION prevent_user_account_security_event_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      RAISE EXCEPTION 'Account security events are append-only';
    END;
    $function$;

    CREATE FUNCTION initialize_user_account_security()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $function$
    BEGIN
      INSERT INTO public.user_account_security (user_id, created_at, updated_at)
      VALUES (NEW.id, NEW.created_at, NEW.created_at);

      INSERT INTO public.user_account_security_events
        (user_id, from_status, to_status, reason_code, created_at)
      VALUES (NEW.id, NULL, 'active', 'account_created', NEW.created_at);

      RETURN NEW;
    END;
    $function$;

    CREATE FUNCTION record_user_account_security_transition()
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

    CREATE TRIGGER user_account_security_update_guard
      BEFORE UPDATE OR DELETE ON user_account_security
      FOR EACH ROW EXECUTE FUNCTION enforce_user_account_security_update();

    CREATE TRIGGER user_account_security_events_immutable
      BEFORE UPDATE OR DELETE ON user_account_security_events
      FOR EACH ROW EXECUTE FUNCTION prevent_user_account_security_event_mutation();

    CREATE TRIGGER users_initialize_account_security
      AFTER INSERT ON users
      FOR EACH ROW EXECUTE FUNCTION initialize_user_account_security();

    CREATE TRIGGER user_account_security_audit
      AFTER UPDATE ON user_account_security
      FOR EACH ROW EXECUTE FUNCTION record_user_account_security_transition();

    REVOKE ALL ON FUNCTION enforce_user_account_security_update() FROM PUBLIC;
    REVOKE ALL ON FUNCTION prevent_user_account_security_event_mutation() FROM PUBLIC;
    REVOKE ALL ON FUNCTION initialize_user_account_security() FROM PUBLIC;
    REVOKE ALL ON FUNCTION record_user_account_security_transition() FROM PUBLIC;

    INSERT INTO user_account_security (user_id, created_at, updated_at)
      SELECT id, created_at, created_at FROM users;

    INSERT INTO user_account_security_events
      (user_id, from_status, to_status, reason_code, created_at)
      SELECT id, NULL, 'active', 'legacy_backfill', created_at
        FROM users;

    DO $verification$
    DECLARE
      user_count bigint;
      state_count bigint;
      event_count bigint;
    BEGIN
      SELECT count(*) INTO user_count FROM users;
      SELECT count(*) INTO state_count FROM user_account_security;
      SELECT count(*) INTO event_count
        FROM user_account_security_events
       WHERE reason_code = 'legacy_backfill'
         AND from_status IS NULL AND to_status = 'active';

      IF user_count <> state_count OR user_count <> event_count THEN
        RAISE EXCEPTION 'Account security backfill verification failed; users %, states %, events %',
          user_count, state_count, event_count;
      END IF;
    END;
    $verification$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DO $preflight$
    BEGIN
      IF EXISTS (SELECT 1 FROM user_account_security)
         OR EXISTS (SELECT 1 FROM user_account_security_events) THEN
        RAISE EXCEPTION 'Refusing to remove account security state or history';
      END IF;
    END;
    $preflight$;

    DROP TRIGGER IF EXISTS user_account_security_audit ON user_account_security;
    DROP TRIGGER IF EXISTS users_initialize_account_security ON users;
    DROP TRIGGER IF EXISTS user_account_security_events_immutable ON user_account_security_events;
    DROP TRIGGER IF EXISTS user_account_security_update_guard ON user_account_security;
    DROP FUNCTION IF EXISTS record_user_account_security_transition();
    DROP FUNCTION IF EXISTS initialize_user_account_security();
    DROP FUNCTION IF EXISTS prevent_user_account_security_event_mutation();
    DROP FUNCTION IF EXISTS enforce_user_account_security_update();
    DROP TABLE IF EXISTS user_account_security_events;
    DROP TABLE IF EXISTS user_account_security;
  `);
};
