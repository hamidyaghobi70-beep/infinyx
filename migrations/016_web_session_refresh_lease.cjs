exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE web_sessions
      ADD COLUMN refresh_lease_id uuid,
      ADD COLUMN refresh_lease_expires_at timestamptz,
      ADD CONSTRAINT web_sessions_refresh_lease_pair_check
        CHECK (
          (refresh_lease_id IS NULL AND refresh_lease_expires_at IS NULL)
          OR
          (refresh_lease_id IS NOT NULL AND refresh_lease_expires_at IS NOT NULL)
        );

    DO $privileges$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'infinyx_app') THEN
        GRANT UPDATE (refresh_lease_id, refresh_lease_expires_at)
          ON public.web_sessions TO infinyx_app;
      END IF;
    END;
    $privileges$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DO $preflight$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM public.web_sessions
         WHERE refresh_lease_id IS NOT NULL
           AND refresh_lease_expires_at > clock_timestamp()
      ) THEN
        RAISE EXCEPTION 'Cannot remove active web-session refresh leases';
      END IF;
    END;
    $preflight$;

    DO $privileges$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'infinyx_app') THEN
        REVOKE UPDATE (refresh_lease_id, refresh_lease_expires_at)
          ON public.web_sessions FROM infinyx_app;
      END IF;
    END;
    $privileges$;

    ALTER TABLE web_sessions
      DROP CONSTRAINT web_sessions_refresh_lease_pair_check,
      DROP COLUMN refresh_lease_expires_at,
      DROP COLUMN refresh_lease_id;
  `);
};
