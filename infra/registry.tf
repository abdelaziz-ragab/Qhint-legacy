# Our service images.
resource "google_artifact_registry_repository" "qhint" {
  repository_id = "qhint"
  location      = var.region
  format        = "DOCKER"
  depends_on    = [google_project_service.apis]

  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 3
    }
  }
}

# Pull-through cache of Docker Hub, so the DB VM can fetch Postgres without internet access.
resource "google_artifact_registry_repository" "dockerhub" {
  repository_id = "dockerhub"
  location      = var.region
  format        = "DOCKER"
  mode          = "REMOTE_REPOSITORY"
  depends_on    = [google_project_service.apis]
  remote_repository_config {
    docker_repository {
      public_repository = "DOCKER_HUB"
    }
  }
}
