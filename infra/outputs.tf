output "control_api_url" {
  value = google_cloud_run_v2_service.control_api.uri
}

output "data_api_url" {
  value = google_cloud_run_v2_service.data_api.uri
}

output "image_repository" {
  value = "${local.registry}/qhint"
}

output "db_internal_ip" {
  value = google_compute_address.db.address
}

output "identity_platform_tenants" {
  value = { for k, t in google_identity_platform_tenant.t : k => t.name }
}
