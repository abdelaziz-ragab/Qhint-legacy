# Optional: operator analytics in BigQuery (content-free fields only; mirrors OperatorEvent).
resource "google_bigquery_dataset" "ops" {
  count       = var.enable_bigquery ? 1 : 0
  dataset_id  = "qhint_ops"
  location    = "US"
  description = "Content-free operator analytics"
  depends_on  = [google_project_service.apis]
}

resource "google_bigquery_table" "operator_events" {
  count               = var.enable_bigquery ? 1 : 0
  dataset_id          = google_bigquery_dataset.ops[0].dataset_id
  table_id            = "operator_events"
  deletion_protection = false
  time_partitioning {
    type  = "DAY"
    field = "ts"
  }
  schema = jsonencode([
    { name = "type", type = "STRING", mode = "REQUIRED" },
    { name = "ts", type = "TIMESTAMP", mode = "REQUIRED" },
    { name = "received_at", type = "TIMESTAMP" },
    { name = "tenantHash", type = "STRING", mode = "REQUIRED" },
    { name = "userHash", type = "STRING" },
    { name = "callType", type = "STRING" },
    { name = "model", type = "STRING" },
    { name = "inputTokens", type = "INT64" },
    { name = "outputTokens", type = "INT64" },
    { name = "cacheReadTokens", type = "INT64" },
    { name = "cacheWriteTokens", type = "INT64" },
    { name = "costMicroUsd", type = "INT64" },
    { name = "latencyMs", type = "INT64" },
    { name = "cacheHit", type = "BOOL" },
    { name = "outcome", type = "STRING" },
    { name = "failureCode", type = "STRING" },
    { name = "count", type = "INT64" },
    { name = "durationMs", type = "INT64" },
    { name = "appCategory", type = "STRING" },
  ])
}
