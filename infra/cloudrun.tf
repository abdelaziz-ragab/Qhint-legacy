# The two services. Both scale to zero (free tier) and reach the database privately.
resource "google_service_account" "control_api" {
  account_id   = "qhint-control-api"
  display_name = "Qhint control-api"
}

resource "google_service_account" "data_api" {
  account_id   = "qhint-data-api"
  display_name = "Qhint data-api"
}

locals {
  control_secrets = ["qhint-control-database-url"]
  data_secrets    = ["qhint-data-database-url", "qhint-analytics-hash-key", "qhint-content-master-key"]
}

resource "google_secret_manager_secret_iam_member" "control" {
  for_each  = toset(local.control_secrets)
  secret_id = google_secret_manager_secret.s[each.value].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.control_api.email}"
}

resource "google_secret_manager_secret_iam_member" "data" {
  for_each  = toset(local.data_secrets)
  secret_id = google_secret_manager_secret.s[each.value].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.data_api.email}"
}

# control-api sets custom claims (tenantId, userId, role) on Identity Platform users.
resource "google_project_iam_member" "control_identity_admin" {
  project = var.project_id
  role    = "roles/firebaseauth.admin"
  member  = "serviceAccount:${google_service_account.control_api.email}"
}

resource "google_project_iam_member" "control_bigquery" {
  count   = var.enable_bigquery ? 1 : 0
  project = var.project_id
  role    = "roles/bigquery.dataEditor"
  member  = "serviceAccount:${google_service_account.control_api.email}"
}

# data-api signs upload/download URLs for objects in the content bucket.
resource "google_storage_bucket_iam_member" "data_content" {
  bucket = google_storage_bucket.content.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.data_api.email}"
}

resource "google_service_account_iam_member" "data_sign_urls" {
  service_account_id = google_service_account.data_api.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_service_account.data_api.email}"
}

resource "google_cloud_run_v2_service" "control_api" {
  name                = "qhint-control-api"
  location            = var.region
  deletion_protection = false
  ingress             = "INGRESS_TRAFFIC_ALL" # desktop app + sign-in page; auth is enforced in-app

  template {
    service_account = google_service_account.control_api.email
    scaling {
      min_instance_count = 0
      max_instance_count = 2
    }
    vpc_access {
      network_interfaces {
        network    = google_compute_network.qhint.id
        subnetwork = google_compute_subnetwork.main.id
      }
      egress = "PRIVATE_RANGES_ONLY"
    }
    containers {
      image = var.control_api_image
      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }
      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "FIREBASE_PROJECT_ID"
        value = var.project_id
      }
      env {
        name  = "FIREBASE_API_KEY"
        value = google_apikeys_key.web.key_string
      }
      env {
        name  = "INTERNAL_AUDIENCE"
        value = local.control_api_url
      }
      env {
        name  = "INTERNAL_ALLOWED_CALLERS"
        value = google_service_account.data_api.email
      }
      env {
        name  = "EVENTS_SINK"
        value = var.enable_bigquery ? "bigquery" : "postgres"
      }
      env {
        name = "CONTROL_DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.s["qhint-control-database-url"].secret_id
            version = "latest"
          }
        }
      }
    }
  }
  depends_on = [google_secret_manager_secret_iam_member.control]
}

resource "google_cloud_run_v2_service" "data_api" {
  name                = "qhint-data-api"
  location            = var.region
  deletion_protection = false
  ingress             = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.data_api.email
    scaling {
      min_instance_count = 0
      max_instance_count = 2
    }
    vpc_access {
      network_interfaces {
        network    = google_compute_network.qhint.id
        subnetwork = google_compute_subnetwork.main.id
      }
      egress = "PRIVATE_RANGES_ONLY"
    }
    containers {
      image = var.data_api_image
      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }
      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "FIREBASE_PROJECT_ID"
        value = var.project_id
      }
      env {
        name  = "CONTROL_API_URL"
        value = local.control_api_url
      }
      dynamic "env" {
        for_each = {
          DATA_DATABASE_URL  = "qhint-data-database-url"
          ANALYTICS_HASH_KEY = "qhint-analytics-hash-key"
          CONTENT_MASTER_KEY = "qhint-content-master-key"
        }
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.s[env.value].secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }
  depends_on = [google_secret_manager_secret_iam_member.data]
}

# Public endpoints: every route except /healthz and the sign-in page requires a valid
# Identity Platform token (or, for /internal, a Google ID token from data-api).
resource "google_cloud_run_v2_service_iam_member" "control_public" {
  name     = google_cloud_run_v2_service.control_api.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_run_v2_service_iam_member" "data_public" {
  name     = google_cloud_run_v2_service.data_api.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}
