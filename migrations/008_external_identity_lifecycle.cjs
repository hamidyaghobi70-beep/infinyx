exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    LOCK TABLE user_external_identities IN SHARE ROW EXCLUSIVE MODE;

    CREATE TABLE user_external_identity_lifecycle (
      identity_id uuid PRIMARY KEY,
      status varchar(16) NOT NULL DEFAULT 'active',
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      status_changed_by uuid,
      status_change_reason varchar(64),
      status_change_correlation_id uuid,
      CONSTRAINT user_external_identity_lifecycle_identity_fk
        FOREIGN KEY (identity_id)
        REFERENCES user_external_identities (identity_id)
        ON DELETE RESTRICT,
      CONSTRAINT user_external_identity_lifecycle_actor_fk
        FOREIGN KEY (status_changed_by) REFERENCES users (id) ON DELETE RESTRICT,
      CONSTRAINT user_external_identity_lifecycle_status_check
        CHECK (status IN ('active', 'suspended', 'revoked')),
      CONSTRAINT user_external_identity_lifecycle_version_check
        CHECK (version >= 1),
      CONSTRAINT user_external_identity_lifecycle_reason_check
        CHECK (status_change_reason IS NULL OR status_change_reason ~ '^[a-z][a-z0-9_]{0,63}$'),
      CONSTRAINT user_external_identity_lifecycle_initial_state_check
        CHECK (
          (version = 1 AND status = 'active' AND status_changed_by IS NULL
            AND status_change_reason IS NULL AND status_change_correlation_id IS NULL)
          OR
          (version > 1 AND status_change_reason IS NOT NULL
            AND status_change_correlation_id IS NOT NULL)
        )
    );

    CREATE TABLE user_external_identity_lifecycle_events (
      event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      identity_id uuid NOT NULL,
      from_status varchar(16),
      to_status varchar(16) NOT NULL,
      actor_user_id uuid,
      reason_code varchar(64) NOT NULL,
      correlation_id uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT user_external_identity_lifecycle_events_identity_fk
        FOREIGN KEY (identity_id)
        REFERENCES user_external_identities (identity_id)
        ON DELETE RESTRICT,
      CONSTRAINT user_external_identity_lifecycle_events_actor_fk
        FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE RESTRICT,
      CONSTRAINT user_external_identity_lifecycle_events_from_status_check
        CHECK (from_status IS NULL OR from_status IN ('active', 'suspended', 'revoked')),
      CONSTRAINT user_external_identity_lifecycle_events_to_status_check
        CHECK (to_status IN ('active', 'suspended', 'revoked')),
      CONSTRAINT user_external_identity_lifecycle_events_reason_check
        CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,63}$')
    );

    CREATE INDEX user_external_identity_lifecycle_status_idx
      ON user_external_identity_lifecycle (status, identity_id);

    CREATE INDEX user_external_identity_lifecycle_events_identity_idx
      ON user_external_identity_lifecycle_events (identity_id, created_at);

    CREATE FUNCTION enforce_external_identity_lifecycle_update()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'External identity lifecycle records are retained';
      END IF;

      IF NEW.identity_id IS DISTINCT FROM OLD.identity_id
         OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'External identity lifecycle identity and creation time are immutable';
      END IF;

      IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
        RAISE EXCEPTION 'Lifecycle records may change only through a status transition';
      END IF;

      IF OLD.status = 'revoked'
         OR NOT (
           (OLD.status = 'active' AND NEW.status IN ('suspended', 'revoked'))
           OR (OLD.status = 'suspended' AND NEW.status IN ('active', 'revoked'))
         ) THEN
        RAISE EXCEPTION 'Invalid external identity lifecycle transition';
      END IF;

      IF NEW.version <> OLD.version + 1
         OR NEW.updated_at <= OLD.updated_at
         OR NEW.status_change_reason IS NULL
         OR NEW.status_change_correlation_id IS NULL THEN
        RAISE EXCEPTION 'External identity lifecycle transition metadata is invalid';
      END IF;

      RETURN NEW;
    END;
    $function$;

    CREATE TRIGGER user_external_identity_lifecycle_update_guard
      BEFORE UPDATE OR DELETE ON user_external_identity_lifecycle
      FOR EACH ROW EXECUTE FUNCTION enforce_external_identity_lifecycle_update();

    CREATE FUNCTION prevent_external_identity_lifecycle_event_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      RAISE EXCEPTION 'External identity lifecycle events are append-only';
    END;
    $function$;

    CREATE TRIGGER user_external_identity_lifecycle_events_immutable
      BEFORE UPDATE OR DELETE ON user_external_identity_lifecycle_events
      FOR EACH ROW EXECUTE FUNCTION prevent_external_identity_lifecycle_event_mutation();

    CREATE FUNCTION initialize_external_identity_lifecycle()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $function$
    BEGIN
      INSERT INTO public.user_external_identity_lifecycle (identity_id)
      VALUES (NEW.identity_id);

      INSERT INTO public.user_external_identity_lifecycle_events
        (identity_id, from_status, to_status, reason_code)
      VALUES (NEW.identity_id, NULL, 'active', 'identity_created');

      RETURN NEW;
    END;
    $function$;

    CREATE TRIGGER user_external_identity_lifecycle_initialize
      AFTER INSERT ON user_external_identities
      FOR EACH ROW EXECUTE FUNCTION initialize_external_identity_lifecycle();

    CREATE FUNCTION record_external_identity_lifecycle_transition()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $function$
    BEGIN
      INSERT INTO public.user_external_identity_lifecycle_events
        (identity_id, from_status, to_status, actor_user_id, reason_code, correlation_id)
      VALUES (
        NEW.identity_id,
        OLD.status,
        NEW.status,
        NEW.status_changed_by,
        NEW.status_change_reason,
        NEW.status_change_correlation_id
      );
      RETURN NEW;
    END;
    $function$;

    CREATE TRIGGER user_external_identity_lifecycle_audit
      AFTER UPDATE ON user_external_identity_lifecycle
      FOR EACH ROW EXECUTE FUNCTION record_external_identity_lifecycle_transition();

    REVOKE ALL ON FUNCTION initialize_external_identity_lifecycle() FROM PUBLIC;
    REVOKE ALL ON FUNCTION record_external_identity_lifecycle_transition() FROM PUBLIC;
    REVOKE ALL ON FUNCTION enforce_external_identity_lifecycle_update() FROM PUBLIC;
    REVOKE ALL ON FUNCTION prevent_external_identity_lifecycle_event_mutation() FROM PUBLIC;

    INSERT INTO user_external_identity_lifecycle (identity_id, created_at, updated_at)
      SELECT identity_id, created_at, created_at FROM user_external_identities
      ON CONFLICT (identity_id) DO NOTHING;

    INSERT INTO user_external_identity_lifecycle_events
      (identity_id, from_status, to_status, reason_code, created_at)
      SELECT identity_id, NULL, 'active', 'legacy_backfill', created_at
        FROM user_external_identities
      ON CONFLICT DO NOTHING;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DO $block$
    BEGIN
      IF EXISTS (SELECT 1 FROM user_external_identity_lifecycle)
         OR EXISTS (SELECT 1 FROM user_external_identity_lifecycle_events) THEN
        RAISE EXCEPTION 'Refusing to remove external identity lifecycle history';
      END IF;
    END;
    $block$;

    DROP TRIGGER IF EXISTS user_external_identity_lifecycle_audit ON user_external_identity_lifecycle;
    DROP TRIGGER IF EXISTS user_external_identity_lifecycle_initialize ON user_external_identities;
    DROP TRIGGER IF EXISTS user_external_identity_lifecycle_events_immutable ON user_external_identity_lifecycle_events;
    DROP TRIGGER IF EXISTS user_external_identity_lifecycle_update_guard ON user_external_identity_lifecycle;
    DROP FUNCTION IF EXISTS record_external_identity_lifecycle_transition();
    DROP FUNCTION IF EXISTS initialize_external_identity_lifecycle();
    DROP FUNCTION IF EXISTS prevent_external_identity_lifecycle_event_mutation();
    DROP FUNCTION IF EXISTS enforce_external_identity_lifecycle_update();
    DROP TABLE IF EXISTS user_external_identity_lifecycle_events;
    DROP TABLE IF EXISTS user_external_identity_lifecycle;
  `);
};
