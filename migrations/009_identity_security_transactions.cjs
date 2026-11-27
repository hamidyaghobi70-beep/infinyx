exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE identity_security_transactions (
      transaction_id uuid NOT NULL DEFAULT gen_random_uuid(),
      state_hash bytea PRIMARY KEY
        CHECK (octet_length(state_hash) = 32),
      user_id uuid NOT NULL
        REFERENCES users (id) ON DELETE RESTRICT,
      session_id_hash bytea NOT NULL
        CHECK (octet_length(session_id_hash) = 32),
      browser_binding_hash bytea NOT NULL
        CHECK (octet_length(browser_binding_hash) = 32),
      purpose varchar(40) NOT NULL
        CHECK (purpose IN ('reauth_identity_link', 'reauth_identity_unlink')),
      encrypted_payload bytea NOT NULL
        CHECK (octet_length(encrypted_payload) BETWEEN 29 AND 4125),
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      consumed_at timestamptz,
      CONSTRAINT identity_security_transactions_id_unique UNIQUE (transaction_id),
      CONSTRAINT identity_security_transactions_expiry_check
        CHECK (expires_at > created_at),
      CONSTRAINT identity_security_transactions_consumed_check
        CHECK (consumed_at IS NULL OR consumed_at >= created_at)
    );

    CREATE INDEX identity_security_transactions_expiry_idx
      ON identity_security_transactions (expires_at);

    CREATE INDEX identity_security_transactions_user_session_idx
      ON identity_security_transactions (user_id, session_id_hash, expires_at)
      WHERE consumed_at IS NULL;

    CREATE TABLE identity_step_up_grants (
      grant_hash bytea PRIMARY KEY
        CHECK (octet_length(grant_hash) = 32),
      source_transaction_id uuid NOT NULL UNIQUE
        REFERENCES identity_security_transactions (transaction_id) ON DELETE RESTRICT,
      user_id uuid NOT NULL
        REFERENCES users (id) ON DELETE RESTRICT,
      session_id_hash bytea NOT NULL
        CHECK (octet_length(session_id_hash) = 32),
      purpose varchar(24) NOT NULL
        CHECK (purpose IN ('identity_link', 'identity_unlink')),
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      consumed_at timestamptz,
      CONSTRAINT identity_step_up_grants_expiry_check
        CHECK (expires_at > created_at AND expires_at <= created_at + interval '5 minutes 5 seconds'),
      CONSTRAINT identity_step_up_grants_consumed_check
        CHECK (consumed_at IS NULL OR consumed_at >= created_at)
    );

    CREATE INDEX identity_step_up_grants_user_session_idx
      ON identity_step_up_grants (user_id, session_id_hash, expires_at)
      WHERE consumed_at IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DO $block$
    BEGIN
      IF EXISTS (SELECT 1 FROM identity_step_up_grants)
         OR EXISTS (SELECT 1 FROM identity_security_transactions) THEN
        RAISE EXCEPTION 'Refusing to remove identity security transaction or step-up grant records';
      END IF;
    END;
    $block$;

    DROP TABLE identity_step_up_grants;
    DROP TABLE identity_security_transactions;
  `);
};
