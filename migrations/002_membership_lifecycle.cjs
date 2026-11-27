exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE tenant_memberships
      DROP CONSTRAINT tenant_memberships_pk,
      DROP CONSTRAINT tenant_memberships_tenant_fk;

    ALTER TABLE tenant_memberships
      ADD COLUMN membership_id uuid NOT NULL DEFAULT gen_random_uuid(),
      ADD COLUMN generation integer NOT NULL DEFAULT 1,
      ADD COLUMN status varchar(16) NOT NULL DEFAULT 'active',
      ADD COLUMN status_changed_at timestamptz NOT NULL DEFAULT now(),
      ADD COLUMN status_changed_by text,
      ADD COLUMN version bigint NOT NULL DEFAULT 1;

    ALTER TABLE tenant_memberships
      ADD CONSTRAINT tenant_memberships_pk PRIMARY KEY (membership_id),
      ADD CONSTRAINT tenant_memberships_tenant_membership_unique
        UNIQUE (tenant_id, membership_id),
      ADD CONSTRAINT tenant_memberships_generation_unique
        UNIQUE (tenant_id, user_id, generation),
      ADD CONSTRAINT tenant_memberships_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE RESTRICT,
      ADD CONSTRAINT tenant_memberships_generation_check CHECK (generation > 0),
      ADD CONSTRAINT tenant_memberships_version_check CHECK (version > 0),
      ADD CONSTRAINT tenant_memberships_status_check
        CHECK (status IN ('active', 'suspended', 'removed'));

    CREATE UNIQUE INDEX tenant_memberships_current_generation_unique
      ON tenant_memberships (tenant_id, user_id)
      WHERE status IN ('active', 'suspended');

    CREATE INDEX tenant_memberships_user_history_idx
      ON tenant_memberships (tenant_id, user_id, generation DESC);

    CREATE TABLE tenant_membership_audit_events (
      event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id text NOT NULL,
      actor_user_id text NOT NULL,
      target_user_id text NOT NULL,
      target_membership_id uuid,
      requested_status varchar(16) NOT NULL,
      previous_status varchar(16),
      outcome varchar(16) NOT NULL,
      reason_code varchar(48) NOT NULL,
      correlation_id uuid NOT NULL,
      occurred_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT tenant_membership_audit_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE RESTRICT,
      CONSTRAINT tenant_membership_audit_membership_fk
        FOREIGN KEY (tenant_id, target_membership_id)
        REFERENCES tenant_memberships (tenant_id, membership_id)
        ON DELETE RESTRICT,
      CONSTRAINT tenant_membership_audit_requested_status_check
        CHECK (requested_status IN ('active', 'suspended', 'removed')),
      CONSTRAINT tenant_membership_audit_previous_status_check
        CHECK (previous_status IS NULL OR previous_status IN ('active', 'suspended', 'removed')),
      CONSTRAINT tenant_membership_audit_outcome_check
        CHECK (outcome IN ('succeeded', 'denied', 'noop')),
      CONSTRAINT tenant_membership_audit_reason_check
        CHECK (char_length(reason_code) BETWEEN 1 AND 48),
      CONSTRAINT tenant_membership_audit_actor_length
        CHECK (char_length(actor_user_id) BETWEEN 1 AND 256),
      CONSTRAINT tenant_membership_audit_target_length
        CHECK (char_length(target_user_id) BETWEEN 1 AND 256),
      CONSTRAINT tenant_membership_audit_correlation_unique
        UNIQUE (tenant_id, correlation_id)
    );

    CREATE INDEX tenant_membership_audit_target_history_idx
      ON tenant_membership_audit_events (tenant_id, target_user_id, occurred_at DESC);

    ALTER TABLE tenant_membership_audit_events ENABLE ROW LEVEL SECURITY;
    ALTER TABLE tenant_membership_audit_events FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_membership_audit_tenant_scope
      ON tenant_membership_audit_events
      USING (tenant_id = current_setting('app.tenant_id', true))
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM tenant_memberships
        WHERE status <> 'active' OR generation <> 1 OR version <> 1
      ) THEN
        RAISE EXCEPTION 'Cannot reverse membership lifecycle migration after lifecycle data has changed';
      END IF;
      IF EXISTS (SELECT 1 FROM tenant_membership_audit_events) THEN
        RAISE EXCEPTION 'Cannot reverse membership lifecycle migration while audit history exists';
      END IF;
    END $$;

    DROP TABLE tenant_membership_audit_events;
    DROP INDEX tenant_memberships_user_history_idx;
    DROP INDEX tenant_memberships_current_generation_unique;

    ALTER TABLE tenant_memberships
      DROP CONSTRAINT tenant_memberships_tenant_membership_unique,
      DROP CONSTRAINT tenant_memberships_generation_unique,
      DROP CONSTRAINT tenant_memberships_generation_check,
      DROP CONSTRAINT tenant_memberships_version_check,
      DROP CONSTRAINT tenant_memberships_status_check,
      DROP CONSTRAINT tenant_memberships_tenant_fk,
      DROP CONSTRAINT tenant_memberships_pk,
      DROP COLUMN membership_id,
      DROP COLUMN generation,
      DROP COLUMN status,
      DROP COLUMN status_changed_at,
      DROP COLUMN status_changed_by,
      DROP COLUMN version;

    ALTER TABLE tenant_memberships
      ADD CONSTRAINT tenant_memberships_pk PRIMARY KEY (tenant_id, user_id),
      ADD CONSTRAINT tenant_memberships_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE;
  `);
};
