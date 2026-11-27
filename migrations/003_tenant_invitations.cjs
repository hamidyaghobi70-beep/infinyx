exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE tenant_invitations (
      invitation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id text NOT NULL,
      identity_type varchar(8) NOT NULL,
      identity_fingerprint bytea NOT NULL,
      identity_key_version integer NOT NULL,
      token_hash bytea NOT NULL,
      token_key_version integer NOT NULL,
      role varchar(16) NOT NULL,
      status varchar(16) NOT NULL DEFAULT 'pending',
      invited_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL DEFAULT (now() + interval '72 hours'),
      accepted_by text,
      accepted_at timestamptz,
      revoked_by text,
      revoked_at timestamptz,
      version bigint NOT NULL DEFAULT 1,
      CONSTRAINT tenant_invitations_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE RESTRICT,
      CONSTRAINT tenant_invitations_tenant_invitation_unique
        UNIQUE (tenant_id, invitation_id),
      CONSTRAINT tenant_invitations_identity_type_check
        CHECK (identity_type IN ('email', 'phone')),
      CONSTRAINT tenant_invitations_identity_fingerprint_check
        CHECK (octet_length(identity_fingerprint) = 32),
      CONSTRAINT tenant_invitations_identity_key_version_check
        CHECK (identity_key_version > 0),
      CONSTRAINT tenant_invitations_token_hash_check
        CHECK (octet_length(token_hash) = 32),
      CONSTRAINT tenant_invitations_token_key_version_check
        CHECK (token_key_version > 0),
      CONSTRAINT tenant_invitations_role_check
        CHECK (role IN ('admin', 'manager', 'editor', 'viewer')),
      CONSTRAINT tenant_invitations_status_check
        CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
      CONSTRAINT tenant_invitations_actor_length
        CHECK (char_length(invited_by) BETWEEN 1 AND 256),
      CONSTRAINT tenant_invitations_expiry_check
        CHECK (expires_at > created_at),
      CONSTRAINT tenant_invitations_version_check
        CHECK (version > 0),
      CONSTRAINT tenant_invitations_acceptance_metadata_check
        CHECK (
          (status = 'accepted' AND accepted_by IS NOT NULL AND accepted_at IS NOT NULL)
          OR (status <> 'accepted' AND accepted_by IS NULL AND accepted_at IS NULL)
        ),
      CONSTRAINT tenant_invitations_revocation_metadata_check
        CHECK (
          (status = 'revoked' AND revoked_by IS NOT NULL AND revoked_at IS NOT NULL)
          OR (status <> 'revoked' AND revoked_by IS NULL AND revoked_at IS NULL)
        ),
      CONSTRAINT tenant_invitations_token_hash_unique UNIQUE (token_hash)
    );

    CREATE INDEX tenant_invitations_pending_identity_idx
      ON tenant_invitations (tenant_id, identity_type, identity_fingerprint)
      WHERE status = 'pending';

    CREATE INDEX tenant_invitations_expiry_idx
      ON tenant_invitations (expires_at)
      WHERE status = 'pending';

    CREATE TABLE tenant_invitation_audit_events (
      event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id text NOT NULL,
      invitation_id uuid,
      actor_user_id text,
      action varchar(32) NOT NULL,
      previous_status varchar(16),
      new_status varchar(16),
      outcome varchar(16) NOT NULL,
      reason_code varchar(48) NOT NULL,
      correlation_id uuid NOT NULL,
      occurred_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT tenant_invitation_audit_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE RESTRICT,
      CONSTRAINT tenant_invitation_audit_invitation_fk
        FOREIGN KEY (tenant_id, invitation_id)
        REFERENCES tenant_invitations (tenant_id, invitation_id)
        ON DELETE RESTRICT,
      CONSTRAINT tenant_invitation_audit_action_check
        CHECK (action IN ('created', 'revoked', 'accepted', 'expired', 'acceptance_denied', 'replay_denied')),
      CONSTRAINT tenant_invitation_audit_previous_check
        CHECK (previous_status IS NULL OR previous_status IN ('pending', 'accepted', 'revoked', 'expired')),
      CONSTRAINT tenant_invitation_audit_new_check
        CHECK (new_status IS NULL OR new_status IN ('pending', 'accepted', 'revoked', 'expired')),
      CONSTRAINT tenant_invitation_audit_outcome_check
        CHECK (outcome IN ('succeeded', 'denied', 'noop')),
      CONSTRAINT tenant_invitation_audit_reason_check
        CHECK (char_length(reason_code) BETWEEN 1 AND 48),
      CONSTRAINT tenant_invitation_audit_actor_length
        CHECK (actor_user_id IS NULL OR char_length(actor_user_id) BETWEEN 1 AND 256),
      CONSTRAINT tenant_invitation_audit_correlation_unique
        UNIQUE (tenant_id, correlation_id)
    );

    CREATE INDEX tenant_invitation_audit_history_idx
      ON tenant_invitation_audit_events (tenant_id, invitation_id, occurred_at DESC);

    CREATE TABLE tenant_invitation_delivery_outbox (
      outbox_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id text NOT NULL,
      invitation_id uuid NOT NULL,
      key_version integer NOT NULL,
      nonce bytea NOT NULL,
      ciphertext bytea NOT NULL,
      auth_tag bytea NOT NULL,
      status varchar(16) NOT NULL DEFAULT 'pending',
      attempts integer NOT NULL DEFAULT 0,
      next_attempt_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      sent_at timestamptz,
      CONSTRAINT tenant_invitation_outbox_invitation_fk
        FOREIGN KEY (tenant_id, invitation_id)
        REFERENCES tenant_invitations (tenant_id, invitation_id)
        ON DELETE RESTRICT,
      CONSTRAINT tenant_invitation_outbox_key_version_check CHECK (key_version > 0),
      CONSTRAINT tenant_invitation_outbox_nonce_check CHECK (octet_length(nonce) = 12),
      CONSTRAINT tenant_invitation_outbox_auth_tag_check CHECK (octet_length(auth_tag) = 16),
      CONSTRAINT tenant_invitation_outbox_status_check CHECK (status IN ('pending', 'sent', 'dead')),
      CONSTRAINT tenant_invitation_outbox_attempts_check CHECK (attempts >= 0),
      CONSTRAINT tenant_invitation_outbox_sent_check
        CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
      CONSTRAINT tenant_invitation_outbox_invitation_unique UNIQUE (invitation_id)
    );

    CREATE INDEX tenant_invitation_outbox_ready_idx
      ON tenant_invitation_delivery_outbox (next_attempt_at, created_at)
      WHERE status = 'pending';

    ALTER TABLE tenant_invitations ENABLE ROW LEVEL SECURITY;
    ALTER TABLE tenant_invitations FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_invitations_tenant_scope ON tenant_invitations
      USING (tenant_id = current_setting('app.tenant_id', true))
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

    ALTER TABLE tenant_invitation_delivery_outbox ENABLE ROW LEVEL SECURITY;
    ALTER TABLE tenant_invitation_delivery_outbox FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_invitation_outbox_tenant_scope ON tenant_invitation_delivery_outbox
      USING (tenant_id = current_setting('app.tenant_id', true))
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

    ALTER TABLE tenant_invitation_audit_events ENABLE ROW LEVEL SECURITY;
    ALTER TABLE tenant_invitation_audit_events FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_invitation_audit_tenant_scope ON tenant_invitation_audit_events
      USING (tenant_id = current_setting('app.tenant_id', true))
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

    CREATE FUNCTION enforce_tenant_invitation_transition()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF NEW.invitation_id IS DISTINCT FROM OLD.invitation_id
         OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
         OR NEW.identity_type IS DISTINCT FROM OLD.identity_type
         OR NEW.identity_fingerprint IS DISTINCT FROM OLD.identity_fingerprint
         OR NEW.identity_key_version IS DISTINCT FROM OLD.identity_key_version
         OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
         OR NEW.token_key_version IS DISTINCT FROM OLD.token_key_version
         OR NEW.role IS DISTINCT FROM OLD.role
         OR NEW.invited_by IS DISTINCT FROM OLD.invited_by
         OR NEW.created_at IS DISTINCT FROM OLD.created_at
         OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
        RAISE EXCEPTION 'Invitation identity and immutable fields cannot be changed';
      END IF;

      IF OLD.status IS DISTINCT FROM NEW.status THEN
        IF OLD.status <> 'pending'
           OR NEW.status NOT IN ('accepted', 'revoked', 'expired')
           OR NEW.version <> OLD.version + 1 THEN
          RAISE EXCEPTION 'Invalid invitation state transition';
        END IF;
        IF NEW.status = 'accepted' AND (NEW.accepted_by IS NULL OR NEW.accepted_at IS NULL) THEN
          RAISE EXCEPTION 'Acceptance metadata is required';
        END IF;
        IF NEW.status = 'revoked' AND (NEW.revoked_by IS NULL OR NEW.revoked_at IS NULL) THEN
          RAISE EXCEPTION 'Revocation metadata is required';
        END IF;
      ELSIF NEW.version <> OLD.version
         OR NEW.accepted_by IS DISTINCT FROM OLD.accepted_by
         OR NEW.accepted_at IS DISTINCT FROM OLD.accepted_at
         OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by
         OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
        RAISE EXCEPTION 'Invitation metadata may change only during a state transition';
      END IF;
      RETURN NEW;
    END;
    $function$;

    CREATE TRIGGER tenant_invitation_transition_guard
      BEFORE UPDATE ON tenant_invitations
      FOR EACH ROW EXECUTE FUNCTION enforce_tenant_invitation_transition();

    CREATE FUNCTION require_tenant_invitation_audit()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF OLD.status IS DISTINCT FROM NEW.status AND NOT EXISTS (
        SELECT 1
          FROM tenant_invitation_audit_events AS audit
         WHERE audit.tenant_id = NEW.tenant_id
           AND audit.invitation_id = NEW.invitation_id
           AND audit.previous_status = OLD.status
           AND audit.new_status = NEW.status
           AND audit.outcome = 'succeeded'
           AND (
             (NEW.status = 'accepted' AND audit.action = 'accepted'
               AND audit.actor_user_id = NEW.accepted_by)
             OR (NEW.status = 'revoked' AND audit.action = 'revoked'
               AND audit.actor_user_id = NEW.revoked_by)
             OR (NEW.status = 'expired' AND audit.action = 'expired')
           )
      ) THEN
        RAISE EXCEPTION 'Invitation transition requires an audit event';
      END IF;
      RETURN NULL;
    END;
    $function$;

    CREATE CONSTRAINT TRIGGER tenant_invitation_audit_required
      AFTER UPDATE ON tenant_invitations
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION require_tenant_invitation_audit();

    CREATE FUNCTION lookup_tenant_for_invitation_token(candidate_hash bytea)
    RETURNS text
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $function$
      SELECT invitation.tenant_id
        FROM public.tenant_invitations AS invitation
       WHERE invitation.token_hash = candidate_hash
       LIMIT 1
    $function$;

    REVOKE ALL ON FUNCTION lookup_tenant_for_invitation_token(bytea) FROM PUBLIC;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DO $block$
    BEGIN
      IF EXISTS (SELECT 1 FROM tenant_invitations)
         OR EXISTS (SELECT 1 FROM tenant_invitation_audit_events) THEN
        RAISE EXCEPTION 'Refusing to drop invitation data during rollback';
      END IF;
    END;
    $block$;

    DROP FUNCTION IF EXISTS lookup_tenant_for_invitation_token(bytea);
    DROP TABLE IF EXISTS tenant_invitation_delivery_outbox;
    DROP TABLE IF EXISTS tenant_invitation_audit_events;
    DROP TABLE IF EXISTS tenant_invitations;
    DROP FUNCTION IF EXISTS require_tenant_invitation_audit();
    DROP FUNCTION IF EXISTS enforce_tenant_invitation_transition();
  `);
};
