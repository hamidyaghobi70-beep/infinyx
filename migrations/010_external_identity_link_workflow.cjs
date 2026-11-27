exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE identity_security_transactions
      DROP CONSTRAINT identity_security_transactions_purpose_check;

    ALTER TABLE identity_security_transactions
      ADD CONSTRAINT identity_security_transactions_purpose_check
      CHECK (purpose IN ('reauth_identity_link', 'reauth_identity_unlink', 'identity_link'));

    CREATE TABLE identity_security_audit_events (
      event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      actor_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
      identity_id uuid REFERENCES user_external_identities (identity_id) ON DELETE RESTRICT,
      event_type varchar(48) NOT NULL
        CHECK (event_type IN ('external_identity.link_succeeded', 'external_identity.link_idempotent', 'external_identity.link_denied')),
      reason_code varchar(64) NOT NULL
        CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
      correlation_id uuid NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX identity_security_audit_events_actor_idx
      ON identity_security_audit_events (actor_user_id, created_at DESC);

    CREATE INDEX identity_security_audit_events_identity_idx
      ON identity_security_audit_events (identity_id, created_at DESC)
      WHERE identity_id IS NOT NULL;

    CREATE FUNCTION prevent_identity_security_audit_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      RAISE EXCEPTION 'Identity security audit events are append-only';
    END;
    $function$;

    CREATE TRIGGER identity_security_audit_events_immutable
      BEFORE UPDATE OR DELETE ON identity_security_audit_events
      FOR EACH ROW EXECUTE FUNCTION prevent_identity_security_audit_mutation();

    CREATE TABLE identity_session_revocation_outbox (
      outbox_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
      audit_event_id uuid NOT NULL UNIQUE
        REFERENCES identity_security_audit_events (event_id) ON DELETE RESTRICT,
      requested_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz,
      attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      last_error_code varchar(64),
      CONSTRAINT identity_session_revocation_outbox_completion_check
        CHECK (completed_at IS NULL OR completed_at >= requested_at),
      CONSTRAINT identity_session_revocation_outbox_error_check
        CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z][a-z0-9_]{0,63}$')
    );

    CREATE UNIQUE INDEX identity_session_revocation_one_pending_user_idx
      ON identity_session_revocation_outbox (user_id)
      WHERE completed_at IS NULL;

    CREATE INDEX identity_session_revocation_pending_idx
      ON identity_session_revocation_outbox (requested_at)
      WHERE completed_at IS NULL;

    CREATE FUNCTION guard_identity_session_revocation_outbox_update()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF NEW.outbox_id IS DISTINCT FROM OLD.outbox_id
         OR NEW.user_id IS DISTINCT FROM OLD.user_id
         OR NEW.audit_event_id IS DISTINCT FROM OLD.audit_event_id
         OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
         OR NEW.attempts < OLD.attempts
         OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at) THEN
        RAISE EXCEPTION 'Invalid identity session revocation outbox mutation';
      END IF;
      RETURN NEW;
    END;
    $function$;

    CREATE TRIGGER identity_session_revocation_outbox_update_guard
      BEFORE UPDATE ON identity_session_revocation_outbox
      FOR EACH ROW EXECUTE FUNCTION guard_identity_session_revocation_outbox_update();

    REVOKE ALL ON FUNCTION prevent_identity_security_audit_mutation() FROM PUBLIC;
    REVOKE ALL ON FUNCTION guard_identity_session_revocation_outbox_update() FROM PUBLIC;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DO $block$
    BEGIN
      IF EXISTS (SELECT 1 FROM identity_security_audit_events)
         OR EXISTS (SELECT 1 FROM identity_session_revocation_outbox)
         OR EXISTS (
           SELECT 1 FROM identity_security_transactions WHERE purpose = 'identity_link'
         ) THEN
        RAISE EXCEPTION 'Refusing to remove identity-link audit, revocation, or transaction data';
      END IF;
    END;
    $block$;

    DROP TRIGGER identity_session_revocation_outbox_update_guard ON identity_session_revocation_outbox;
    DROP TRIGGER identity_security_audit_events_immutable ON identity_security_audit_events;
    DROP FUNCTION guard_identity_session_revocation_outbox_update();
    DROP FUNCTION prevent_identity_security_audit_mutation();
    DROP TABLE identity_session_revocation_outbox;
    DROP TABLE identity_security_audit_events;

    ALTER TABLE identity_security_transactions
      DROP CONSTRAINT identity_security_transactions_purpose_check;
    ALTER TABLE identity_security_transactions
      ADD CONSTRAINT identity_security_transactions_purpose_check
      CHECK (purpose IN ('reauth_identity_link', 'reauth_identity_unlink'));
  `);
};
