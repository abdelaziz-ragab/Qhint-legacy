# Private network: the database VM has no public IP; Cloud Run reaches it via Direct VPC egress.
resource "google_compute_network" "qhint" {
  name                    = "qhint"
  auto_create_subnetworks = false
  depends_on              = [google_project_service.apis]
}

resource "google_compute_subnetwork" "main" {
  name                     = "qhint-${var.region}"
  network                  = google_compute_network.qhint.id
  region                   = var.region
  ip_cidr_range            = "10.20.0.0/24"
  private_ip_google_access = true # lets the DB VM reach Artifact Registry / GCS without internet
}

resource "google_compute_address" "db" {
  name         = "qhint-db-internal"
  subnetwork   = google_compute_subnetwork.main.id
  address_type = "INTERNAL"
  address      = "10.20.0.10"
  region       = var.region
}

resource "google_compute_firewall" "postgres_from_subnet" {
  name          = "qhint-allow-postgres-from-subnet"
  network       = google_compute_network.qhint.id
  direction     = "INGRESS"
  source_ranges = [google_compute_subnetwork.main.ip_cidr_range]
  target_tags   = ["qhint-db"]
  allow {
    protocol = "tcp"
    ports    = ["5432"]
  }
}

# Admin SSH only through Identity-Aware Proxy (Google identity check), never from the internet.
resource "google_compute_firewall" "ssh_from_iap" {
  name          = "qhint-allow-ssh-from-iap"
  network       = google_compute_network.qhint.id
  direction     = "INGRESS"
  source_ranges = ["35.235.240.0/20"]
  target_tags   = ["qhint-db"]
  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}
