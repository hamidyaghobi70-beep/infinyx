exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE web_sessions
      ADD COLUMN refresh_attempt_id uuid;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS web_sessions_refresh_attempt_id_idx;
    ALTER TABLE web_sessions DROP COLUMN refresh_attempt_id;
  `);
};
