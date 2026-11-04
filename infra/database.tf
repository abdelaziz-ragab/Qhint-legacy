# Postgres 17 + pgvector on the always-free e2-micro VM (Container-Optimized OS, no public IP).
# Swappable for Cloud SQL later: services only know the connection URL in Secret Manager.
resource "google_service_account" "db" {
  account_id   = "qhint-db-vm"
  display_name = "Qhint database VM"
}

resource "google_project_iam_member" "db_logs" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.db.email}"
}

resource "google_artifact_registry_repository_iam_member" "db_pull" {
  repository = google_artifact_registry_repository.dockerhub.name
  location   = var.region
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.db.email}"
}

resource "google_secret_manager_secret_iam_member" "db_owner_password" {
  secret_id = google_secret_manager_secret.s["qhint-db-owner-password"].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.db.email}"
}

resource "google_storage_bucket_iam_member" "db_backup_writer" {
  bucket = google_storage_bucket.backups.name
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${google_service_account.db.email}"
}

resource "google_compute_instance" "db" {
  name                      = "qhint-db"
  machine_type              = "e2-micro"
  zone                      = var.zone
  tags                      = ["qhint-db"]
  allow_stopping_for_update = true

  boot_disk {
    initialize_params {
      image = "cos-cloud/cos-stable"
      size  = 30
      type  = "pd-standard" # free tier covers 30 GB of standard disk
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.main.id
    network_ip = google_compute_address.db.address
    # No access_config: no public IP.
  }

  service_account {
    email  = google_service_account.db.email
    scopes = ["cloud-platform"]
  }

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  metadata = {
    enable-oslogin         = "TRUE"
    block-project-ssh-keys = "TRUE"
    google-logging-enabled = "true"
    user-data = templatefile("${path.module}/db-cloud-init.yaml.tftpl", {
      image           = "${local.registry}/dockerhub/pgvector/pgvector:0.8.7-pg17"
      registry_host   = "${var.region}-docker.pkg.dev"
      listen_ip       = google_compute_address.db.address
      password_secret = "projects/${var.project_id}/secrets/qhint-db-owner-password/versions/latest"
      backup_bucket   = google_storage_bucket.backups.name
    })
  }

  depends_on = [google_secret_manager_secret_version.s]
}
