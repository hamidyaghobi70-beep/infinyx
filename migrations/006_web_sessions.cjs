exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE web_sessions (
      session_id_hash bytea PRIMARY KEY
        CHECK (octet_length(session_id_hash) = 32),
      user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      issuer text NOT NULL CHECK (length(issuer) BETWEEN 1 AND 2048),
      subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 512),
      csrf_token_hash bytea NOT NULL CHECK (octet_length(csrf_token_hash) = 32),
      encrypted_token_bundle bytea NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz NOT NULL DEFAULT now(),
      idle_expires_at timestamptz NOT NULL,
      absolute_expires_at timestamptz NOT NULL,
      revoked_at timestamptz,
      CHECK (idle_expires_at <= absolute_expires_at),
      CHECK (last_seen_at <= absolute_expires_at)
    );

    CREATE INDEX web_sessions_user_active_idx
      ON web_sessions (user_id, absolute_expires_at)
      WHERE revoked_at IS NULL;

    CREATE INDEX web_sessions_expiry_idx
      ON web_sessions (idle_expires_at, absolute_expires_at);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM web_sessions) THEN
        RAISE EXCEPTION 'Cannot remove web session storage while session records exist';
      END IF;
    END $$;

    DROP TABLE web_sessions;
  `);
};
