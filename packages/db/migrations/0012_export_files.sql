-- Task 15: export files.
--
-- An export job now produces a real file, so the row has to remember what the
-- file is called and what kind of bytes it holds, and the sweep has to be able
-- to name the files it is about to orphan: deleting the row first would leave
-- bytes in the object store with nothing left pointing at them.
-- The old constraint was written inline, so its name was chosen by the server.
-- It is found by what it checks rather than by a name this file assumes.
DO $$
DECLARE
    old_name text;
BEGIN
    FOR old_name IN
    SELECT
        conname
    FROM
        pg_constraint
    WHERE
        conrelid = 'public.export_jobs'::regclass
        AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%kind%' LOOP
            EXECUTE format('ALTER TABLE export_jobs DROP CONSTRAINT %I', old_name);
        END LOOP;
END
$$;

ALTER TABLE export_jobs
    ADD CONSTRAINT export_jobs_kind_check CHECK (kind IN ('students', 'staff', 'audit', 'student_profile', 'staff_profile', 'timetable'));

-- The name the person sees when the file lands, and the type the download
-- route sets on the response. Both are server state: neither is ever taken
-- from a request.
ALTER TABLE export_jobs
    ADD COLUMN file_name text,
    ADD COLUMN content_type text;

-- The assurance the request that asked for the file had already reached, and
-- the moment the second factor was checked. A job built later by the daily
-- route replays exactly these, so a file can never be produced under a
-- stronger session than the one that asked for it. A row that names nothing is
-- read as the weakest answer, single_factor.
ALTER TABLE export_jobs
    ADD COLUMN requested_assurance text,
    ADD COLUMN requested_mfa_verified_at timestamptz;

ALTER TABLE export_jobs
    ADD CONSTRAINT export_jobs_requested_assurance_check CHECK (requested_assurance IS NULL OR requested_assurance IN ('single_factor', 'mfa'));

-- Producing a queued job crosses schools, so the maintenance route needs a way
-- to find the work without any login gaining BYPASSRLS. Same shape as the
-- sweep functions in 0009: owned by erp_maintenance, executable by erp_runtime
-- and by nobody else.
-- The user behind the membership comes back with the job, so the route never
-- has to stand a membership id in for a person.
--
-- The rule from 0011: ownership moves to erp_maintenance below, and a
-- non-superuser migrator can only do that while the new owner holds CREATE on
-- the schema. It is granted here and taken away again at the end of this file.
GRANT CREATE ON SCHEMA public TO erp_maintenance;

CREATE FUNCTION list_queued_export_jobs ()
    RETURNS TABLE (
        school_id uuid,
        id uuid,
        requested_by_membership_id uuid,
        requested_by_user_id uuid)
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = pg_catalog,
    public
    AS $$
    SELECT
        job.school_id,
        job.id,
        job.requested_by_membership_id,
        member.user_id AS requested_by_user_id
    FROM
        public.export_jobs AS job
        JOIN public.school_memberships AS member ON member.school_id = job.school_id
            AND member.id = job.requested_by_membership_id
    WHERE
        job.status = 'queued'
        AND job.expires_at > now()
    ORDER BY
        job.created_at
    LIMIT 200;
$$;

ALTER FUNCTION list_queued_export_jobs () OWNER TO erp_maintenance;

REVOKE ALL ON FUNCTION list_queued_export_jobs () FROM PUBLIC;

GRANT EXECUTE ON FUNCTION list_queued_export_jobs () TO erp_runtime;

-- The files the sweep is about to delete the rows for. The threshold is the
-- one sweep_tenant_transients () already uses, so the two always agree: the
-- route removes these bytes first and then calls the sweep.
CREATE FUNCTION list_expired_export_files ()
    RETURNS TABLE (
        school_id uuid,
        id uuid,
        storage_key text)
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = pg_catalog,
    public
    AS $$
    SELECT
        job.school_id,
        job.id,
        job.storage_key
    FROM
        public.export_jobs AS job
    WHERE
        job.expires_at < now() - interval '1 day'
        AND job.storage_key IS NOT NULL
    LIMIT 1000;
$$;

ALTER FUNCTION list_expired_export_files () OWNER TO erp_maintenance;

REVOKE ALL ON FUNCTION list_expired_export_files () FROM PUBLIC;

GRANT EXECUTE ON FUNCTION list_expired_export_files () TO erp_runtime;

-- Once the bytes are gone the row must stop naming them, so the list above
-- moves on instead of handing back the same page for ever. The row itself is
-- left for sweep_tenant_transients () to delete.
-- 0009 gave the sweep role SELECT and DELETE here; clearing a key needs one
-- more verb, and the maintenance_sweep policy already covers every verb.
GRANT UPDATE ON export_jobs TO erp_maintenance;

CREATE FUNCTION forget_export_file (p_school_id uuid, p_id uuid)
    RETURNS void
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = pg_catalog,
    public
    AS $$
    UPDATE
        public.export_jobs
    SET
        storage_key = NULL,
        updated_at = now()
    WHERE
        school_id = p_school_id
        AND id = p_id;
$$;

ALTER FUNCTION forget_export_file (uuid, uuid) OWNER TO erp_maintenance;

REVOKE ALL ON FUNCTION forget_export_file (uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION forget_export_file (uuid, uuid) TO erp_runtime;

-- The ownership transfers are done, so the bootstrap grant goes away again.
REVOKE CREATE ON SCHEMA public FROM erp_maintenance;
