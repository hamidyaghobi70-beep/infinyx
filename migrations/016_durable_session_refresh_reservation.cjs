exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE web_sessions
      ADD COLUMN refresh_attempt_id uuid;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DO $preflight$
    BEGIN
      IF EXISTS (
        SELECT 1
          FROM public.web_sessions
         WHERE refresh_attempt_id IS NOT NULL
      ) THEN
        RAISE EXCEPTION 'Refusing to remove web-session refresh reservations while an attempt is active or ambiguous';
      END IF;
    END;
    $preflight$;

    DROP INDEX IF EXISTS web_sessions_refresh_attempt_id_idx;
    ALTER TABLE web_sessions DROP COLUMN refresh_attempt_id;
  `);
};
