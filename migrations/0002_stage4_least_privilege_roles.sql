-- Least-privilege, non-login group roles for the Stage 4 persistence boundary.
-- Run as a database administrator/migration owner. Bind service LOGIN roles to these
-- NOLOGIN groups separately in deployment configuration; never store passwords here.

DO $$
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
$;

-- Existing same-name roles are not trusted merely because they already exist.
-- Fail closed rather than silently retaining LOGIN or elevated cluster privileges.
DO $
DECLARE
  unsafe_roles text;
BEGIN
  SELECT string_agg(rolname, ', ' ORDER BY rolname)
    INTO unsafe_roles
  FROM pg_roles
  WHERE rolname IN ('infinyx_memory_runtime', 'infinyx_audit_writer', 'infinyx_audit_reader')
    AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls);

  IF unsafe_roles IS NOT NULL THEN
    RAISE EXCEPTION 'Stage 4 roles have unsafe attributes; refusing grants: %', unsafe_roles;
  END IF;
END
$;

REVOKE ALL ON SCHEMA infinyx_memory FROM PUBLIC;
REVOKE ALL ON SCHEMA infinyx_audit FROM PUBLIC;
GRANT USAGE ON SCHEMA infinyx_memory TO infinyx_memory_runtime;
GRANT USAGE ON SCHEMA infinyx_audit TO infinyx_audit_writer, infinyx_audit_reader;

REVOKE ALL ON infinyx_memory.memory_entries FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON infinyx_memory.memory_entries TO infinyx_memory_runtime;

REVOKE ALL ON infinyx_audit.audit_chain_state FROM PUBLIC;
GRANT SELECT, UPDATE
  ON infinyx_audit.audit_chain_state TO infinyx_audit_writer;

REVOKE ALL ON infinyx_audit.memory_access_events FROM PUBLIC;
GRANT INSERT ON infinyx_audit.memory_access_events TO infinyx_audit_writer;
GRANT SELECT ON infinyx_audit.memory_access_events TO infinyx_audit_reader;

-- Intentionally absent: UPDATE/DELETE on audit events, schema CREATE, role admin,
-- and any membership grant to a LOGIN role. Deployment owners must explicitly grant
-- membership to the corresponding service identity after reviewing the trust boundary.
