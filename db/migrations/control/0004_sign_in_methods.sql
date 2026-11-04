-- Which sign-in methods each company offers on the sign-in page. Shape (validated by control-api,
-- which falls back to the default if the stored value is invalid):
--   { "password": bool, "google": bool, "microsoft": bool,
--     "sso": null | { "type": "saml" | "oidc", "providerId": "saml.<id>" | "oidc.<id>", "label": text } }
ALTER TABLE control.tenants
  ADD COLUMN sign_in_methods jsonb NOT NULL
    DEFAULT '{"password": true, "google": true, "microsoft": false, "sso": null}';

COMMENT ON COLUMN control.tenants.sign_in_methods IS
  'Sign-in methods offered to this tenant''s users: {password, google, microsoft, sso}. sso is null or {type, providerId, label}.';
