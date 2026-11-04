# Generated secrets. Values live in Secret Manager (read by services at runtime) and in the
# Terraform state, which is why state must stay in the private state bucket.
resource "random_password" "db_owner" {
  length  = 40
  special = false
}

resource "random_password" "db_control_app" {
  length  = 40
  special = false
}

resource "random_password" "db_data_app" {
  length  = 40
  special = false
}

resource "random_password" "analytics_hash_key" {
  length  = 48
  special = false
}

resource "random_id" "content_master_key" {
  byte_length = 32
}

locals {
  db_host = google_compute_address.db.address
  secrets = {
    "qhint-db-owner-password"       = random_password.db_owner.result
    "qhint-db-control-app-password" = random_password.db_control_app.result
    "qhint-db-data-app-password"    = random_password.db_data_app.result
    "qhint-control-database-url"    = "postgres://qhint_control_app:${random_password.db_control_app.result}@${local.db_host}:5432/qhint"
    "qhint-data-database-url"       = "postgres://qhint_data_app:${random_password.db_data_app.result}@${local.db_host}:5432/qhint"
    "qhint-analytics-hash-key"      = random_password.analytics_hash_key.result
    "qhint-content-master-key"      = random_id.content_master_key.b64_std
  }
}

resource "google_secret_manager_secret" "s" {
  for_each  = local.secrets
  secret_id = each.key
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "s" {
  for_each    = local.secrets
  secret      = google_secret_manager_secret.s[each.key].id
  secret_data = each.value
}
