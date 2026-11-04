# Customer content (uploads). Objects live under t/<tenant-id>/; access only via signed URLs.
resource "google_storage_bucket" "content" {
  name                        = "${var.project_id}-content"
  location                    = upper(var.region) # regional US bucket = free-tier eligible
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  depends_on                  = [google_project_service.apis]
}

# Nightly database backups, kept for a limited time.
resource "google_storage_bucket" "backups" {
  name                        = "${var.project_id}-db-backups"
  location                    = upper(var.region)
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  depends_on                  = [google_project_service.apis]

  lifecycle_rule {
    condition {
      age = var.backup_retention_days
    }
    action {
      type = "Delete"
    }
  }
}
