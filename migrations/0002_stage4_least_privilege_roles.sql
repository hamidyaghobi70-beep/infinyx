-- Least-privilege, non-login group roles for the Stage 4 persistence boundary.
-- Run as a database administrator/migration owner. Bind service LOGIN roles to these
-- NOLOGIN groups separately in deployment configuration; never store passwords here.

DO $stage4_create_roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'infinyx_memory_runtime') THEN
    EXECUTE 'CREATE ROLE infinyx_memory_runtime NOLOGIN';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'infinyx_audit_writer') THEN
    EXECUTE 'CREATE ROLE infinyx_audit_writer NOLOGIN';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'infinyx_audit_reader') THEN
    EXECUTE 'CREATE ROLE infinyx_audit_reader NOLOGIN';
  END IF;
END
$stage4_create_roles$;

-- Existing same-name roles are not trusted merely because they already exist.
-- Fail closed on login/elevated attributes and direct or transitive role memberships.
DO $stage4_validate_roles$
DECLARE
  unsafe_roles text;
BEGIN
  SELECT string_agg(r.rolname, ', ' ORDER BY r.rolname)
    INTO unsafe_roles
  FROM pg_roles AS r
  WHERE r.rolname IN ('infinyx_memory_runtime', 'infinyx_audit_writer', 'infinyx_audit_reader')
    AND (
      r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole
      OR r.rolreplication OR r.rolbypassrls
      -- Ownership is an implicit privilege and cannot be neutralized by REVOKE.
      -- Reject these service roles if they own any database object, including a
      -- pre-existing Stage 4 schema/table that CREATE IF NOT EXISTS would preserve.
      OR EXISTS (
        SELECT 1
        FROM pg_shdepend AS dependency
        WHERE dependency.refclassid = 'pg_authid'::regclass
          AND dependency.refobjid = r.oid
          AND dependency.deptype = 'o'
      )
      OR EXISTS (
        WITH RECURSIVE inherited_roles(role_oid) AS (
          SELECT membership.roleid
          FROM pg_auth_members AS membership
          WHERE membership.member = r.oid
          UNION
          SELECT membership.roleid
          FROM pg_auth_members AS membership
          JOIN inherited_roles AS inherited
            ON membership.member = inherited.role_oid
        )
        SELECT 1 FROM inherited_roles
      )
    );

  IF unsafe_roles IS NOT NULL THEN
    RAISE EXCEPTION 'Stage 4 roles have unsafe attributes or memberships; refusing grants: %', unsafe_roles;
  END IF;
END
$stage4_validate_roles$;

-- Normalize pre-existing direct ACLs before applying the allowlist. REVOKE from
-- PUBLIC alone is insufficient when a same-name service role already has grants.
REVOKE ALL ON SCHEMA infinyx_memory FROM PUBLIC;
REVOKE ALL ON SCHEMA infinyx_memory FROM infinyx_memory_runtime, infinyx_audit_writer, infinyx_audit_reader;
REVOKE ALL ON SCHEMA infinyx_audit FROM PUBLIC;
REVOKE ALL ON SCHEMA infinyx_audit FROM infinyx_memory_runtime, infinyx_audit_writer, infinyx_audit_reader;

REVOKE ALL ON infinyx_memory.memory_entries FROM PUBLIC;
REVOKE ALL ON infinyx_memory.memory_entries FROM infinyx_memory_runtime, infinyx_audit_writer, infinyx_audit_reader;
REVOKE ALL ON infinyx_audit.audit_chain_state FROM PUBLIC;
REVOKE ALL ON infinyx_audit.audit_chain_state FROM infinyx_memory_runtime, infinyx_audit_writer, infinyx_audit_reader;
REVOKE ALL ON infinyx_audit.memory_access_events FROM PUBLIC;
REVOKE ALL ON infinyx_audit.memory_access_events FROM infinyx_memory_runtime, infinyx_audit_writer, infinyx_audit_reader;

GRANT USAGE ON SCHEMA infinyx_memory TO infinyx_memory_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON infinyx_memory.memory_entries TO infinyx_memory_runtime;

GRANT USAGE ON SCHEMA infinyx_audit TO infinyx_audit_writer, infinyx_audit_reader;
GRANT SELECT, UPDATE
  ON infinyx_audit.audit_chain_state TO infinyx_audit_writer;
GRANT INSERT ON infinyx_audit.memory_access_events TO infinyx_audit_writer;
GRANT SELECT ON infinyx_audit.memory_access_events TO infinyx_audit_reader;

-- Intentionally absent: UPDATE/DELETE on audit events, schema CREATE, role admin,
-- and any membership grant to a LOGIN role. Deployment owners must explicitly grant
-- membership to the corresponding service identity after reviewing the trust boundary.
