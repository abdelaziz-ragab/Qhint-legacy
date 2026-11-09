-- Phase 6: turning uploaded videos and documents into draft procedures.
--
-- content.ingest_jobs holds only job state (no customer content), so the background worker can
-- claim queued jobs across tenants. It does that with app.role = 'ingest_worker' and no tenant:
-- that role sees only queued/running rows and may only mark them running or failed. Everything
-- else (reading the upload, writing the procedure, the report) runs as the job's owner, under
-- the normal tenant policies.

CREATE TABLE content.ingest_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  owner_id        uuid NOT NULL,
  document_id     uuid NOT NULL,
  status          text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'running', 'done', 'failed')),
  stage           text NOT NULL DEFAULT 'queued'
                  CHECK (stage IN ('queued', 'reading', 'frames', 'transcribing', 'writing',
                                   'images', 'saving', 'done', 'failed')),
  progress        integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  -- Spoken language of the source (BCP-47, e.g. en-US) and the language to write the guide in.
  language        text NOT NULL DEFAULT 'en-US' CHECK (language ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  output_language text NOT NULL DEFAULT 'English' CHECK (length(output_language) BETWEEN 2 AND 40),
  -- Content-free failure code (e.g. too_long, no_procedure, provider_error).
  error_code      text CHECK (error_code ~ '^[a-z_]{1,40}$'),
  procedure_id    uuid,
  attempts        integer NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES content.documents (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, procedure_id) REFERENCES content.procedures (tenant_id, id) ON DELETE SET NULL (procedure_id)
);
CREATE INDEX ON content.ingest_jobs (status, created_at);
CREATE INDEX ON content.ingest_jobs (tenant_id, owner_id);

-- What the author should review (unclear steps, problems). Customer content: owner only.
CREATE TABLE content.ingest_reports (
  job_id     uuid PRIMARY KEY,
  tenant_id  uuid NOT NULL,
  owner_id   uuid NOT NULL,
  body       jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, job_id) REFERENCES content.ingest_jobs (tenant_id, id) ON DELETE CASCADE
);

-- When the uploaded source file was deleted from storage (kept only until the guide is made).
ALTER TABLE content.documents ADD COLUMN source_deleted_at timestamptz;

ALTER TABLE content.ingest_jobs    ENABLE ROW LEVEL SECURITY;
ALTER TABLE content.ingest_jobs    FORCE ROW LEVEL SECURITY;
ALTER TABLE content.ingest_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE content.ingest_reports FORCE ROW LEVEL SECURITY;

CREATE FUNCTION content.is_ingest_worker() RETURNS boolean
  LANGUAGE sql STABLE
  AS $$ SELECT coalesce(content.current_app_role() = 'ingest_worker', false)
               AND content.current_tenant() IS NULL $$;

-- Owners: their own jobs.
CREATE POLICY ingest_jobs_owner ON content.ingest_jobs
  USING (tenant_id = content.current_tenant() AND owner_id = content.current_user_id())
  WITH CHECK (tenant_id = content.current_tenant() AND owner_id = content.current_user_id());

-- Worker: see waiting/in-flight jobs; only claim them (running) or give up on them (failed).
CREATE POLICY ingest_jobs_worker_read ON content.ingest_jobs FOR SELECT
  USING (content.is_ingest_worker() AND status IN ('queued', 'running'));
CREATE POLICY ingest_jobs_worker_claim ON content.ingest_jobs FOR UPDATE
  USING (content.is_ingest_worker() AND status IN ('queued', 'running'))
  WITH CHECK (content.is_ingest_worker() AND status IN ('running', 'failed'));

CREATE POLICY ingest_reports_owner ON content.ingest_reports
  USING (tenant_id = content.current_tenant() AND owner_id = content.current_user_id())
  WITH CHECK (tenant_id = content.current_tenant() AND owner_id = content.current_user_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON content.ingest_jobs, content.ingest_reports TO qhint_data_app;
GRANT EXECUTE ON FUNCTION content.is_ingest_worker() TO qhint_data_app;
