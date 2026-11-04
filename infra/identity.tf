# Identity Platform with multi-tenancy: one tenant per customer company. Each tenant offers email +
# password and Google; SSO (SAML/OIDC) and Microsoft come later. Which buttons the sign-in page
# shows per company lives in control.tenants.sign_in_methods.
#
# Access is invite-only, but NOT by disabling sign-up here: an invited user's first Google sign-in
# creates their federated account, which Identity Platform counts as a sign-up, and the sign-in
# page's project-level Google step (used to learn the email) needs sign-up too. Instead, every API
# refuses tokens without our custom claims, and control-api sets claims only for invited users with
# a verified email inside their company's tenant. A stray self-created account therefore gets
# nothing; a blocking function that rejects non-invited sign-ups is on the later list.
# User self-deletion must stay allowed: the page deletes its temporary project-level account.
resource "google_identity_platform_config" "this" {
  project = var.project_id
  multi_tenant {
    allow_tenants = true
  }
  client {
    permissions {
      disabled_user_signup = false # see the note at the top of this file
    }
  }
  authorized_domains = [
    "localhost",
    "${var.project_id}.firebaseapp.com",
    trimprefix(local.control_api_url, "https://"),
  ]
  depends_on = [google_project_service.apis]
}

resource "google_identity_platform_tenant" "t" {
  for_each     = var.tenants
  display_name = each.value
  # Enables the email/password provider. Passwords are set at provisioning; a self-created
  # password account gets no claims and so no access (see the note at the top of this file).
  allow_password_signup    = true
  enable_email_link_signin = false
  disable_auth             = false
  # Tenants don't inherit the project setting, so it is set on each one explicitly.
  client {
    permissions {
      disabled_user_signup = false
    }
  }
  depends_on = [google_identity_platform_config.this]
}

# Google at the project level (no tenant): the sign-in page's first Google step runs here only to
# read the user's email, then deletes that temporary account and signs the same Google credential
# into the company's tenant. Project and tenants MUST share one OAuth client, or the tenant rejects
# the credential obtained at the project level.
resource "google_identity_platform_default_supported_idp_config" "google" {
  count         = var.google_oauth_client_id == "" ? 0 : 1
  idp_id        = "google.com"
  client_id     = var.google_oauth_client_id
  client_secret = var.google_oauth_client_secret
  enabled       = true
  depends_on    = [google_identity_platform_config.this]
}

resource "google_identity_platform_tenant_default_supported_idp_config" "google" {
  for_each      = var.google_oauth_client_id == "" ? {} : var.tenants
  tenant        = google_identity_platform_tenant.t[each.key].name
  idp_id        = "google.com"
  client_id     = var.google_oauth_client_id
  client_secret = var.google_oauth_client_secret
  enabled       = true
}

# Later: a company's own SSO is one provider on its tenant. Its id ("saml.<x>" / "oidc.<x>") goes
# into control.tenants.sign_in_methods.sso.providerId so the sign-in page offers the SSO button.
#
# resource "google_identity_platform_tenant_inbound_saml_config" "sso" {
#   tenant       = google_identity_platform_tenant.t["<company>"].name
#   name         = "saml.<company>"
#   display_name = "<Company> SSO"
#   enabled      = true
#   idp_config {
#     idp_entity_id = "<from the customer's IdP metadata>"
#     sso_url       = "<from the customer's IdP metadata>"
#     idp_certificates {
#       x509_certificate = "<from the customer's IdP metadata>"
#     }
#   }
#   sp_config {
#     sp_entity_id = "<our entity id for this company>"
#     callback_uri = "https://${var.project_id}.firebaseapp.com/__/auth/handler"
#   }
# }
#
# resource "google_identity_platform_tenant_oauth_idp_config" "sso" {
#   tenant        = google_identity_platform_tenant.t["<company>"].name
#   name          = "oidc.<company>"
#   display_name  = "<Company> SSO"
#   issuer        = "<customer's OIDC issuer URL>"
#   client_id     = "<client id registered with the customer's IdP>"
#   client_secret = "<from Secret Manager>"
#   enabled       = true
# }

# Browser API key for the sign-in page and token refresh (public by design; restricted to the
# two auth APIs).
resource "google_apikeys_key" "web" {
  name         = "qhint-web"
  display_name = "Qhint sign-in (browser)"
  restrictions {
    api_targets {
      service = "identitytoolkit.googleapis.com"
    }
    api_targets {
      service = "securetoken.googleapis.com"
    }
  }
  depends_on = [google_project_service.apis]
}
