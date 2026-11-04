-- Content tables. Every row carries tenant_id; row-level security is enabled AND forced on every
-- table, and the data-api role never owns them. Each request runs in a transaction that first
-- sets app.tenant_id / app.user_id / app.role from the verified token (SET LOCAL). With nothing
-- set, the helpers return NULL and every policy matches no rows: fail closed.

-- The data plane may live in its own database later, so it creates its own role if missing.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qhint_data_app') THEN
    CREATE ROLE qhint_data_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

REVOKE ALL ON SCHEMA content FROM PUBLIC;

CREATE FUNCTION content.current_tenant() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE FUNCTION content.current_user_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

CREATE FUNCTION content.current_app_role() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.role', true), '') $$;

CREATE FUNCTION content.is_admin() RETURNS boolean
  LANGUAGE sql STABLE
  AS $$ SELECT coalesce(content.current_app_role() = 'admin', false) $$;

-- ---------------------------------------------------------------- documents (uploaded sources)
CREATE TABLE content.documents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  owner_id     uuid NOT NULL,
  visibility   text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'company')),
  kind         text NOT NULL CHECK (kind IN ('doc', 'video', 'recording')),
  title        text NOT NULL,
  storage_key  text NOT NULL,
  content_type text NOT NULL,
  size_bytes   bigint NOT NULL CHECK (size_bytes > 0),
  status       text NOT NULL DEFAULT 'pending_upload'
               CHECK (status IN ('pending_upload', 'uploaded', 'processing', 'ready', 'failed')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  -- Object keys always live under the tenant's prefix.
  CHECK (storage_key LIKE 't/' || tenant_id::text || '/%')
);

-- ---------------------------------------------------------------- procedures
CREATE TABLE content.procedures (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  owner_id           uuid NOT NULL,
  visibility         text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'company')),
  status             text NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft', 'in_review', 'published')),
  version            integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  source             text NOT NULL CHECK (source IN ('video', 'doc', 'recording', 'generated')),
  source_document_id uuid,
  title              text NOT NULL,
  -- apps, variables, steps (validated against the shared zod Procedure schema on write).
  body               jsonb NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  -- Composite FK: a procedure can only reference a document of the same tenant.
  FOREIGN KEY (tenant_id, source_document_id) REFERENCES content.documents (tenant_id, id)
);

-- ---------------------------------------------------------------- runs + step results
CREATE TABLE content.runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  user_id           uuid NOT NULL,
  procedure_id      uuid,
  procedure_version integer,
  mode              text NOT NULL CHECK (mode IN ('guided', 'live')),
  status            text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'completed', 'abandoned', 'stopped_at_gap')),
  started_at        timestamptz NOT NULL DEFAULT now(),
  ended_at          timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, procedure_id) REFERENCES content.procedures (tenant_id, id)
);

CREATE TABLE content.step_results (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  run_id        uuid NOT NULL,
  step_id       text NOT NULL,
  outcome       text NOT NULL CHECK (outcome IN ('done', 'skipped', 'stuck', 'gap', 'abandoned')),
  advance       text CHECK (advance IN ('manual', 'verified')),
  locate_source text NOT NULL CHECK (locate_source IN ('cache', 'model', 'none')),
  attempts      integer NOT NULL CHECK (attempts >= 0),
  duration_ms   integer NOT NULL CHECK (duration_ms >= 0),
  finished_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, run_id) REFERENCES content.runs (tenant_id, id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------- gaps
CREATE TABLE content.gaps (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  user_id      uuid NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('no_procedure', 'missing_info', 'vague_step',
                                             'contradiction', 'outdated', 'runner_stuck')),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  question     text,
  description  text NOT NULL,
  procedure_id uuid,
  step_id      text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, procedure_id) REFERENCES content.procedures (tenant_id, id)
);

CREATE INDEX ON content.documents (tenant_id, owner_id);
CREATE INDEX ON content.procedures (tenant_id, status, visibility);
CREATE INDEX ON content.procedures (tenant_id, owner_id);
CREATE INDEX ON content.runs (tenant_id, user_id);
CREATE INDEX ON content.step_results (tenant_id, run_id);
CREATE INDEX ON content.gaps (tenant_id, status);

-- ---------------------------------------------------------------- row-level security
ALTER TABLE content.documents    ENABLE ROW LEVEL SECURITY;
ALTER TABLE content.documents    FORCE ROW LEVEL SECURITY;
ALTER TABLE content.procedures   ENABLE ROW LEVEL SECURITY;
ALTER TABLE content.procedures   FORCE ROW LEVEL SECURITY;
ALTER TABLE content.runs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE content.runs         FORCE ROW LEVEL SECURITY;
ALTER TABLE content.step_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE content.step_results FORCE ROW LEVEL SECURITY;
ALTER TABLE content.gaps         ENABLE ROW LEVEL SECURITY;
ALTER TABLE content.gaps         FORCE ROW LEVEL SECURITY;

-- Documents and procedures: you see your own, the company's published ones, and admins also see
-- what's submitted for review. Nobody (not even an admin) sees another user's private drafts.
CREATE POLICY documents_read ON content.documents FOR SELECT USING (
  tenant_id = content.current_tenant()
  AND (owner_id = content.current_user_id() OR visibility = 'company')
);
CREATE POLICY documents_insert ON content.documents FOR INSERT WITH CHECK (
  tenant_id = content.current_tenant()
  AND owner_id = content.current_user_id()
  AND (visibility = 'private' OR content.is_admin())
);
CREATE POLICY documents_update ON content.documents FOR UPDATE
  USING (tenant_id = content.current_tenant()
         AND (owner_id = content.current_user_id() OR content.is_admin()))
  WITH CHECK (tenant_id = content.current_tenant()
              AND (visibility = 'private' OR content.is_admin()));
CREATE POLICY documents_delete ON content.documents FOR DELETE USING (
  tenant_id = content.current_tenant()
  AND (owner_id = content.current_user_id() OR content.is_admin())
);

CREATE POLICY procedures_read ON content.procedures FOR SELECT USING (
  tenant_id = content.current_tenant()
  AND (
    owner_id = content.current_user_id()
    OR (visibility = 'company' AND status = 'published')
    OR (content.is_admin() AND status IN ('in_review', 'published'))
  )
);
CREATE POLICY procedures_insert ON content.procedures FOR INSERT WITH CHECK (
  tenant_id = content.current_tenant()
  AND owner_id = content.current_user_id()
  AND ((visibility = 'private' AND status IN ('draft', 'in_review')) OR content.is_admin())
);
CREATE POLICY procedures_update ON content.procedures FOR UPDATE
  USING (
    tenant_id = content.current_tenant()
    AND (owner_id = content.current_user_id()
         OR (content.is_admin() AND status IN ('in_review', 'published')))
  )
  WITH CHECK (
    tenant_id = content.current_tenant()
    -- Only admins can publish or make something company-visible.
    AND ((visibility = 'private' AND status IN ('draft', 'in_review')) OR content.is_admin())
  );
CREATE POLICY procedures_delete ON content.procedures FOR DELETE USING (
  tenant_id = content.current_tenant()
  AND (owner_id = content.current_user_id() OR content.is_admin())
);

-- Runs, step results, gaps: users see their own; admins see the whole tenant (usage, gap log).
CREATE POLICY runs_rw ON content.runs
  USING (tenant_id = content.current_tenant()
         AND (user_id = content.current_user_id() OR content.is_admin()))
  WITH CHECK (tenant_id = content.current_tenant() AND user_id = content.current_user_id());

CREATE POLICY step_results_rw ON content.step_results
  USING (tenant_id = content.current_tenant()
         AND EXISTS (SELECT 1 FROM content.runs r
                     WHERE r.id = run_id AND r.tenant_id = content.current_tenant()))
  WITH CHECK (tenant_id = content.current_tenant()
              AND EXISTS (SELECT 1 FROM content.runs r
                          WHERE r.id = run_id AND r.user_id = content.current_user_id()));

CREATE POLICY gaps_read ON content.gaps FOR SELECT USING (
  tenant_id = content.current_tenant()
  AND (user_id = content.current_user_id() OR content.is_admin())
);
CREATE POLICY gaps_insert ON content.gaps FOR INSERT WITH CHECK (
  tenant_id = content.current_tenant() AND user_id = content.current_user_id()
);
CREATE POLICY gaps_update ON content.gaps FOR UPDATE
  USING (tenant_id = content.current_tenant() AND content.is_admin())
  WITH CHECK (tenant_id = content.current_tenant());

-- ---------------------------------------------------------------- grants
GRANT USAGE ON SCHEMA content TO qhint_data_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA content TO qhint_data_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA content TO qhint_data_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA content
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO qhint_data_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA content
  GRANT EXECUTE ON FUNCTIONS TO qhint_data_app;
