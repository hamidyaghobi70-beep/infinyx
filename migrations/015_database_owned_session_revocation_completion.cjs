exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE FUNCTION complete_identity_session_revocation(
      p_outbox_id uuid,
      p_user_id uuid
    )
    RETURNS boolean
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $function$
    DECLARE
      target_user_id uuid;
    BEGIN
      SELECT user_id INTO target_user_id
        FROM public.identity_session_revocation_outbox
       WHERE outbox_id = p_outbox_id
         AND user_id = p_user_id
         AND completed_at IS NULL
       FOR UPDATE;

      IF target_user_id IS NULL THEN
        RETURN false;
      END IF;

      UPDATE public.web_sessions
         SET revoked_at = COALESCE(revoked_at, clock_timestamp())
       WHERE user_id = target_user_id
         AND revoked_at IS NULL;

      UPDATE public.identity_session_revocation_outbox
         SET completed_at = GREATEST(clock_timestamp(), requested_at),
             attempts = attempts + 1,
             last_error_code = NULL
       WHERE outbox_id = p_outbox_id
         AND user_id = p_user_id
         AND completed_at IS NULL;

      RETURN FOUND;
    END;
    $function$;

    CREATE FUNCTION complete_user_account_session_revocation(
      p_outbox_id uuid,
      p_user_id uuid
    )
    RETURNS boolean
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $function$
    DECLARE
      target_user_id uuid;
    BEGIN
      SELECT user_id INTO target_user_id
        FROM public.user_account_session_revocation_outbox
       WHERE outbox_id = p_outbox_id
         AND user_id = p_user_id
         AND completed_at IS NULL
       FOR UPDATE;

      IF target_user_id IS NULL THEN
        RETURN false;
      END IF;

      UPDATE public.web_sessions
         SET revoked_at = COALESCE(revoked_at, clock_timestamp())
       WHERE user_id = target_user_id
         AND revoked_at IS NULL;

      UPDATE public.user_account_session_revocation_outbox
         SET completed_at = GREATEST(clock_timestamp(), requested_at),
             attempts = attempts + 1,
             last_error_code = NULL
       WHERE outbox_id = p_outbox_id
         AND user_id = p_user_id
         AND completed_at IS NULL;

      RETURN FOUND;
    END;
    $function$;

    REVOKE ALL ON FUNCTION complete_identity_session_revocation(uuid, uuid) FROM PUBLIC;
    REVOKE ALL ON FUNCTION complete_user_account_session_revocation(uuid, uuid) FROM PUBLIC;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DO $preflight$
    BEGIN
      IF EXISTS (SELECT 1 FROM identity_session_revocation_outbox)
         OR EXISTS (SELECT 1 FROM user_account_session_revocation_outbox) THEN
        RAISE EXCEPTION 'Refusing to remove database-owned session revocation completion while outbox records exist';
      END IF;
    END;
    $preflight$;

    DROP FUNCTION complete_user_account_session_revocation(uuid, uuid);
    DROP FUNCTION complete_identity_session_revocation(uuid, uuid);
  `);
};
