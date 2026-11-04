-- Users are invited by email before they ever sign in; their Firebase uid is linked on first
-- sign-in (control-api /auth/session). Emails are matched case-insensitively.
ALTER TABLE control.users ALTER COLUMN firebase_uid DROP NOT NULL;
ALTER TABLE control.users DROP CONSTRAINT users_tenant_id_email_key;
CREATE UNIQUE INDEX users_tenant_email_lower ON control.users (tenant_id, lower(email));
CREATE INDEX users_email_lower ON control.users (lower(email));
