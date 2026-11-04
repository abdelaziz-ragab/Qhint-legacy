-- Application roles. Migrations run as the schema owner; the services connect as these roles:
--   qhint_control_app: control schema only. Cannot read or write any content table.
--   qhint_data_app:    content schema only, always subject to row-level security.
-- Passwords are set outside migrations (from secrets), never in this file.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qhint_control_app') THEN
    CREATE ROLE qhint_control_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qhint_data_app') THEN
    CREATE ROLE qhint_data_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

-- Where each tenant's data plane lives. Phase 1: every tenant points to the shared default.
CREATE TABLE control.data_plane_locations (
  tenant_id   uuid PRIMARY KEY REFERENCES control.tenants (id) ON DELETE CASCADE,
  -- Base URL of the tenant's data-api.
  endpoint    text NOT NULL,
  -- Storage bucket holding the tenant's content (objects are under t/<tenant_id>/).
  bucket      text NOT NULL,
  -- Reference to the tenant's encryption key (KeyProvider-specific, never the key itself).
  key_ref     text NOT NULL,
  region      text NOT NULL DEFAULT 'us-central1',
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Content-free operator analytics (whitelisted fields only, validated before insert).
-- Local/demo sink; production can use BigQuery behind the same interface.
CREATE TABLE control.operator_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now(),
  event       jsonb NOT NULL
);

REVOKE ALL ON SCHEMA control FROM PUBLIC;
GRANT USAGE ON SCHEMA control TO qhint_control_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA control TO qhint_control_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA control TO qhint_control_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA control
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO qhint_control_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA control
  GRANT USAGE, SELECT ON SEQUENCES TO qhint_control_app;
