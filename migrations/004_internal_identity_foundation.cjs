exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE user_external_identities (
      identity_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL,
      issuer varchar(2048) NOT NULL,
      subject varchar(512) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT user_external_identities_user_fk
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT,
      CONSTRAINT user_external_identities_issuer_check
        CHECK (
          char_length(issuer) BETWEEN 1 AND 2048
          AND issuer = btrim(issuer)
          AND issuer ~ '^https://[^[:space:]]+$'
        ),
      CONSTRAINT user_external_identities_subject_check
        CHECK (
          char_length(subject) BETWEEN 1 AND 512
          AND subject !~ '[[:cntrl:]]'
        ),
      CONSTRAINT user_external_identities_issuer_subject_unique
        UNIQUE (issuer, subject)
    );

    CREATE INDEX user_external_identities_user_idx
      ON user_external_identities (user_id, created_at);

    CREATE FUNCTION prevent_external_identity_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      RAISE EXCEPTION 'External identity records are immutable';
    END;
    $function$;

    CREATE TRIGGER user_external_identity_immutable
      BEFORE UPDATE OR DELETE ON user_external_identities
      FOR EACH ROW EXECUTE FUNCTION prevent_external_identity_mutation();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DO $block$
    BEGIN
      IF EXISTS (SELECT 1 FROM user_external_identities)
         OR EXISTS (SELECT 1 FROM users) THEN
        RAISE EXCEPTION 'Refusing to drop internal identity data during rollback';
      END IF;
    END;
    $block$;

    DROP TABLE IF EXISTS user_external_identities;
    DROP TABLE IF EXISTS users;
    DROP FUNCTION IF EXISTS prevent_external_identity_mutation();
  `);
};
