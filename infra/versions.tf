terraform {
  required_version = ">= 1.9"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 8.10"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.9"
    }
  }
  # State holds generated secrets, so it lives in a private GCS bucket (see README: bootstrap).
  backend "gcs" {}
}

provider "google" {
  project = var.project_id
  region  = var.region
  zone    = var.zone
}

data "google_project" "this" {}

locals {
  project_number = data.google_project.this.number
  # Cloud Run's deterministic URL format: https://<service>-<project-number>.<region>.run.app
  control_api_url = "https://qhint-control-api-${local.project_number}.${var.region}.run.app"
  data_api_url    = "https://qhint-data-api-${local.project_number}.${var.region}.run.app"
  registry        = "${var.region}-docker.pkg.dev/${var.project_id}"
}
