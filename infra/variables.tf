variable "project_id" {
  type        = string
  description = "GCP project for this environment (e.g. qhint-dev-1ff9)."
}

variable "region" {
  type        = string
  default     = "us-central1"
  description = "Must be us-central1, us-east1 or us-west1 to stay in the e2-micro / storage free tier."
}

variable "zone" {
  type    = string
  default = "us-central1-a"
}

variable "control_api_image" {
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
  description = "Container image for control-api (placeholder until the first deploy)."
}

variable "data_api_image" {
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
  description = "Container image for data-api (placeholder until the first deploy)."
}

variable "google_oauth_client_id" {
  type        = string
  default     = ""
  description = "OAuth client for Google sign-in (created once in the console; see README)."
}

variable "google_oauth_client_secret" {
  type      = string
  default   = ""
  sensitive = true
}

variable "tenants" {
  type        = map(string)
  default     = { demo = "demo" }
  description = "Identity Platform tenants to create: key => display name (4-20 chars, letters/digits/hyphens)."
}

variable "enable_bigquery" {
  type        = bool
  default     = false
  description = "Send operator analytics to BigQuery instead of Postgres (both are free at demo volume)."
}

variable "backup_retention_days" {
  type    = number
  default = 14
}
