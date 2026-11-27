exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE tenants (
      id text PRIMARY KEY,
      name varchar(160) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT tenants_id_length CHECK (char_length(id) BETWEEN 1 AND 256)
    );

    CREATE TABLE tenant_memberships (
      tenant_id text NOT NULL,
      user_id text NOT NULL,
      role varchar(16) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT tenant_memberships_pk PRIMARY KEY (tenant_id, user_id),
      CONSTRAINT tenant_memberships_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
      CONSTRAINT tenant_memberships_user_id_length
        CHECK (char_length(user_id) BETWEEN 1 AND 256),
      CONSTRAINT tenant_memberships_role_check
        CHECK (role IN ('owner', 'admin', 'manager', 'editor', 'viewer'))
    );

    ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
    ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenants_tenant_scope ON tenants
      USING (id = current_setting('app.tenant_id', true))
      WITH CHECK (id = current_setting('app.tenant_id', true));

    ALTER TABLE tenant_memberships ENABLE ROW LEVEL SECURITY;
    ALTER TABLE tenant_memberships FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_memberships_tenant_scope ON tenant_memberships
      USING (tenant_id = current_setting('app.tenant_id', true))
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS tenant_memberships;
    DROP TABLE IF EXISTS tenants;
  `);
};
