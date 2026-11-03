-- Control plane: tenants and users. Never holds customer content.
CREATE SCHEMA IF NOT EXISTS control;

CREATE TABLE control.tenants (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  -- Identity Platform tenant id; set once the tenant exists in Identity Platform.
  firebase_tenant_id text UNIQUE,
  -- Used to route sign-in to the right Identity Platform tenant.
  email_domains      text[] NOT NULL DEFAULT '{}',
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE control.users (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES control.tenants (id),
  firebase_uid text NOT NULL,
  email        text NOT NULL,
  role         text NOT NULL CHECK (role IN ('employee', 'admin')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, firebase_uid),
  UNIQUE (tenant_id, email)
);
