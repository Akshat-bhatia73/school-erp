-- Task 5 working tables: a staged bulk import and a queued export job.
--
-- Both hold work in progress rather than school records, so both expire. The
-- import preview keeps only rows the server already validated, never the
-- uploaded file. The export job remembers the permission and the access
-- version it was requested under, so a job cannot outlive the access that
-- justified it: a later role change moves access_version and the job is
-- refused rather than served from a stale decision.
CREATE TABLE student_import_previews (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    school_id uuid NOT NULL REFERENCES schools (id) ON DELETE CASCADE,
    created_by_membership_id uuid NOT NULL,
    academic_year_id uuid NOT NULL,
    status text NOT NULL CHECK (status IN ('pending', 'committed', 'expired')),
    total_rows integer NOT NULL CHECK (total_rows >= 0),
    valid_rows integer NOT NULL CHECK (valid_rows >= 0),
    rows jsonb NOT NULL,
    errors jsonb NOT NULL DEFAULT '[]'::jsonb,
    expires_at timestamptz NOT NULL,
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (valid_rows <= total_rows),
    UNIQUE (school_id, id),
    FOREIGN KEY (school_id, created_by_membership_id) REFERENCES school_memberships (school_id, id),
    FOREIGN KEY (school_id, academic_year_id) REFERENCES academic_years (school_id, id)
);

CREATE INDEX student_import_previews_expiry_idx ON student_import_previews (school_id, expires_at);

CREATE TABLE export_jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    school_id uuid NOT NULL REFERENCES schools (id) ON DELETE CASCADE,
    requested_by_membership_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('students', 'staff', 'audit')),
    status text NOT NULL CHECK (status IN ('queued', 'ready', 'failed', 'expired')),
    access_version integer NOT NULL CHECK (access_version >= 0),
    permission text NOT NULL,
    criteria jsonb NOT NULL DEFAULT '{}'::jsonb,
    row_count integer CHECK (row_count IS NULL OR row_count >= 0),
    storage_key text,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (school_id, id),
    FOREIGN KEY (school_id, requested_by_membership_id) REFERENCES school_memberships (school_id, id)
);

CREATE INDEX export_jobs_requester_idx ON export_jobs (school_id, requested_by_membership_id, created_at);

DO $$
DECLARE
    table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY['student_import_previews', 'export_jobs'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
        EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (school_id = NULLIF(current_setting(''app.school_id'', true), '''')::uuid) WITH CHECK (school_id = NULLIF(current_setting(''app.school_id'', true), '''')::uuid)', table_name);
    END LOOP;
END
$$;

REVOKE ALL ON student_import_previews, export_jobs FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON student_import_previews, export_jobs TO erp_runtime;
