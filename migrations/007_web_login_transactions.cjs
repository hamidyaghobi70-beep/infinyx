exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE web_login_transactions (
      state_hash bytea PRIMARY KEY CHECK (octet_length(state_hash) = 32),
      browser_binding_hash bytea NOT NULL CHECK (octet_length(browser_binding_hash) = 32),
      encrypted_transaction bytea NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      consumed_at timestamptz,
      CHECK (expires_at > created_at)
    );

    CREATE INDEX web_login_transactions_expiry_idx
      ON web_login_transactions (expires_at)
      WHERE consumed_at IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM web_login_transactions WHERE consumed_at IS NULL AND expires_at > now()) THEN
        RAISE EXCEPTION 'Cannot remove active OIDC login transactions';
      END IF;
    END $$;

    DROP TABLE web_login_transactions;
  `);
};
