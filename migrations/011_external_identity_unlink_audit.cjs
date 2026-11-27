exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    LOCK TABLE identity_security_audit_events IN SHARE ROW EXCLUSIVE MODE;

    DO $preflight$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'identity_security_audit_events'::regclass
           AND conname = 'identity_security_audit_events_event_type_check'
      ) THEN
        RAISE EXCEPTION 'Expected identity security audit event constraint is missing';
      END IF;

      IF EXISTS (
        SELECT 1 FROM identity_security_audit_events
         WHERE event_type NOT IN (
           'external_identity.link_succeeded',
           'external_identity.link_idempotent',
           'external_identity.link_denied',
           'external_identity.unlink_succeeded',
           'external_identity.unlink_denied'
         )
      ) THEN
        RAISE EXCEPTION 'Unexpected identity audit event found; refusing B3 constraint migration';
      END IF;
    END;
    $preflight$;

    ALTER TABLE identity_security_audit_events
      DROP CONSTRAINT identity_security_audit_events_event_type_check;

    ALTER TABLE identity_security_audit_events
      ADD CONSTRAINT identity_security_audit_events_event_type_check
      CHECK (event_type IN (
        'external_identity.link_succeeded',
        'external_identity.link_idempotent',
        'external_identity.link_denied',
        'external_identity.unlink_succeeded',
        'external_identity.unlink_denied'
      )) NOT VALID;

    ALTER TABLE identity_security_audit_events
      VALIDATE CONSTRAINT identity_security_audit_events_event_type_check;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DO $preflight$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM identity_security_audit_events
         WHERE event_type IN (
           'external_identity.unlink_succeeded',
           'external_identity.unlink_denied'
         )
      ) THEN
        RAISE EXCEPTION 'Refusing to remove identity unlink audit history';
      END IF;
    END;
    $preflight$;

    ALTER TABLE identity_security_audit_events
      DROP CONSTRAINT identity_security_audit_events_event_type_check;

    ALTER TABLE identity_security_audit_events
      ADD CONSTRAINT identity_security_audit_events_event_type_check
      CHECK (event_type IN (
        'external_identity.link_succeeded',
        'external_identity.link_idempotent',
        'external_identity.link_denied'
      ));
  `);
};
