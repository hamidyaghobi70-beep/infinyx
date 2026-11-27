exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE tenant_memberships
      ADD COLUMN internal_user_id uuid;

    ALTER TABLE tenant_memberships
      ADD CONSTRAINT tenant_memberships_internal_user_fk
        FOREIGN KEY (internal_user_id) REFERENCES users (id) ON DELETE RESTRICT,
      ADD CONSTRAINT tenant_memberships_internal_user_legacy_consistency
        CHECK (internal_user_id IS NULL OR user_id = internal_user_id::text);

    CREATE UNIQUE INDEX tenant_memberships_internal_generation_unique
      ON tenant_memberships (tenant_id, internal_user_id, generation)
      WHERE internal_user_id IS NOT NULL;

    CREATE UNIQUE INDEX tenant_memberships_internal_current_unique
      ON tenant_memberships (tenant_id, internal_user_id)
      WHERE internal_user_id IS NOT NULL AND status IN ('active', 'suspended');

    CREATE INDEX tenant_memberships_internal_history_idx
      ON tenant_memberships (tenant_id, internal_user_id, generation DESC)
      WHERE internal_user_id IS NOT NULL;

    CREATE OR REPLACE FUNCTION enforce_membership_lifecycle_update()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF NEW.membership_id IS DISTINCT FROM OLD.membership_id
         OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
         OR NEW.user_id IS DISTINCT FROM OLD.user_id
         OR NEW.internal_user_id IS DISTINCT FROM OLD.internal_user_id
         OR NEW.generation IS DISTINCT FROM OLD.generation
         OR NEW.role IS DISTINCT FROM OLD.role THEN
        RAISE EXCEPTION 'Membership identity, role, and generation require separate governance';
      END IF;

      IF OLD.status IS DISTINCT FROM NEW.status THEN
        IF OLD.role = 'owner' THEN
          RAISE EXCEPTION 'Owner lifecycle changes require ownership governance';
        END IF;
        IF NEW.status_changed_by = OLD.user_id THEN
          RAISE EXCEPTION 'Self lifecycle changes are not allowed';
        END IF;
        IF NOT (
          (OLD.status = 'active' AND NEW.status IN ('suspended', 'removed'))
          OR (OLD.status = 'suspended' AND NEW.status IN ('active', 'removed'))
        ) THEN
          RAISE EXCEPTION 'Invalid membership lifecycle transition';
        END IF;
        IF NEW.version <> OLD.version + 1 OR NEW.status_changed_by IS NULL
           OR NEW.status_change_correlation_id IS NULL THEN
          RAISE EXCEPTION 'Membership lifecycle metadata is invalid';
        END IF;
      ELSIF NEW.version <> OLD.version
         OR NEW.status_changed_at IS DISTINCT FROM OLD.status_changed_at
         OR NEW.status_changed_by IS DISTINCT FROM OLD.status_changed_by
         OR NEW.status_change_correlation_id IS DISTINCT FROM OLD.status_change_correlation_id THEN
        RAISE EXCEPTION 'Lifecycle metadata may change only with a status transition';
      END IF;

      RETURN NEW;
    END;
    $function$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM tenant_memberships WHERE internal_user_id IS NOT NULL
      ) THEN
        RAISE EXCEPTION 'Cannot reverse internal-user membership mapping while mapped membership data exists';
      END IF;
    END $$;

    DROP INDEX tenant_memberships_internal_history_idx;
    DROP INDEX tenant_memberships_internal_current_unique;
    DROP INDEX tenant_memberships_internal_generation_unique;

    ALTER TABLE tenant_memberships
      DROP CONSTRAINT tenant_memberships_internal_user_legacy_consistency,
      DROP CONSTRAINT tenant_memberships_internal_user_fk,
      DROP COLUMN internal_user_id;

    CREATE OR REPLACE FUNCTION enforce_membership_lifecycle_update()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF NEW.membership_id IS DISTINCT FROM OLD.membership_id
         OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
         OR NEW.user_id IS DISTINCT FROM OLD.user_id
         OR NEW.generation IS DISTINCT FROM OLD.generation
         OR NEW.role IS DISTINCT FROM OLD.role THEN
        RAISE EXCEPTION 'Membership identity, role, and generation require separate governance';
      END IF;

      IF OLD.status IS DISTINCT FROM NEW.status THEN
        IF OLD.role = 'owner' THEN
          RAISE EXCEPTION 'Owner lifecycle changes require ownership governance';
        END IF;
        IF NEW.status_changed_by = OLD.user_id THEN
          RAISE EXCEPTION 'Self lifecycle changes are not allowed';
        END IF;
        IF NOT (
          (OLD.status = 'active' AND NEW.status IN ('suspended', 'removed'))
          OR (OLD.status = 'suspended' AND NEW.status IN ('active', 'removed'))
        ) THEN
          RAISE EXCEPTION 'Invalid membership lifecycle transition';
        END IF;
        IF NEW.version <> OLD.version + 1 OR NEW.status_changed_by IS NULL
           OR NEW.status_change_correlation_id IS NULL THEN
          RAISE EXCEPTION 'Membership lifecycle metadata is invalid';
        END IF;
      ELSIF NEW.version <> OLD.version
         OR NEW.status_changed_at IS DISTINCT FROM OLD.status_changed_at
         OR NEW.status_changed_by IS DISTINCT FROM OLD.status_changed_by
         OR NEW.status_change_correlation_id IS DISTINCT FROM OLD.status_change_correlation_id THEN
        RAISE EXCEPTION 'Lifecycle metadata may change only with a status transition';
      END IF;

      RETURN NEW;
    END;
    $function$;
  `);
};
