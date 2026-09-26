-- Proposals (Task 24, part 24b). See docs/assistant/ARCHITECTURE.md section 5.
--
-- A change tool never writes. It saves a proposal: an editable preview of the
-- change, the GET route whose answer it was read from, and a digest of that
-- answer. When the person confirms, the API builds the write from the edited
-- preview, reads the same route again and compares the digest, so a record
-- someone changed in between is never overwritten, and then calls the real
-- write route as the person. The write route writes its own audit row; this
-- row keeps that request's id so the two can be joined.
--
-- The preview names pupils and marks, so it is sealed with the application
-- key like the rest of a conversation, and goes with it after 30 days.
--
-- Additive: the release before this one never reads the new table.

CREATE TABLE assistant_proposals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    school_id uuid NOT NULL REFERENCES schools (id) ON DELETE CASCADE,
    thread_id uuid NOT NULL,
    membership_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('attendance_day', 'staff_attendance_day', 'exam_marks', 'co_scholastic')),
    -- The tool that made it, so confirming uses the same definition.
    tool_name text NOT NULL CHECK (tool_name ~ '^[a-z][a-z0-9_]{1,63}$'),
    title_sealed text NOT NULL,
    preview_sealed text NOT NULL,
    -- The preview as the person confirmed it, when it was written; the
    -- original above never changes.
    confirmed_preview_sealed text,
    -- The GET route (relative to /api/schools/:schoolId) read to make it, and
    -- a SHA-256 digest of its answer at that moment.
    -- (Postgres regular expressions repeat at most 255 times, so the length is
    -- its own check.)
    check_path text NOT NULL CHECK (check_path ~ '^/[A-Za-z0-9/_.?=&%-]+$' AND length(check_path) <= 401),
    check_digest text NOT NULL CHECK (check_digest ~ '^[0-9a-f]{64}$'),
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'dismissed', 'expired', 'stale', 'failed')),
    -- Plain words about the outcome: what was saved, or why nothing was.
    outcome text CHECK (outcome IS NULL OR length(outcome) <= 500),
    -- The request id of the real write, which is the id on its audit row.
    write_request_id text,
    -- True when the person changed the preview before confirming.
    edited boolean,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    decided_at timestamptz,
    UNIQUE (school_id, id),
    FOREIGN KEY (school_id, thread_id) REFERENCES assistant_threads (school_id, id) ON DELETE CASCADE,
    FOREIGN KEY (school_id, membership_id) REFERENCES school_memberships (school_id, id) ON DELETE CASCADE,
    CHECK ((status = 'open') = (decided_at IS NULL) OR status = 'expired')
);

CREATE INDEX assistant_proposals_thread_idx ON assistant_proposals (school_id, thread_id, created_at);

CREATE INDEX assistant_proposals_age_idx ON assistant_proposals (created_at);

ALTER TABLE assistant_proposals ENABLE ROW LEVEL SECURITY;

ALTER TABLE assistant_proposals FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON assistant_proposals
    USING (school_id = NULLIF(current_setting('app.school_id', TRUE), '')::uuid)
    WITH CHECK (school_id = NULLIF(current_setting('app.school_id', TRUE), '')::uuid);

REVOKE ALL ON assistant_proposals FROM PUBLIC;

GRANT SELECT, INSERT ON assistant_proposals TO erp_runtime;

-- Only the outcome moves after a proposal is made; its preview never does.
GRANT UPDATE (status, outcome, write_request_id, edited, confirmed_preview_sealed, decided_at) ON assistant_proposals TO erp_runtime;

-- Retention: with the conversation, 30 days. A function of its own, owned by
-- erp_maintenance like sweep_assistant (), which this migration leaves as it
-- is; the nightly sweep calls both. The rule from 0011: ownership moves to
-- erp_maintenance only while it holds CREATE on the schema.
GRANT CREATE ON SCHEMA public TO erp_maintenance;

CREATE POLICY maintenance_sweep ON assistant_proposals
    FOR ALL TO erp_maintenance
        USING (TRUE)
        WITH CHECK (TRUE);

GRANT SELECT, DELETE ON assistant_proposals TO erp_maintenance;

CREATE FUNCTION sweep_assistant_proposals ()
    RETURNS TABLE (
        item text,
        count integer)
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog,
    public
    AS $$
DECLARE
    removed integer;
BEGIN
    DELETE FROM public.assistant_proposals
    WHERE created_at < now() - interval '30 days';
    GET DIAGNOSTICS removed = ROW_COUNT;
    item := 'assistant_proposals';
    count := removed;
    RETURN NEXT;
END
$$;

ALTER FUNCTION sweep_assistant_proposals () OWNER TO erp_maintenance;

REVOKE ALL ON FUNCTION sweep_assistant_proposals () FROM PUBLIC;

GRANT EXECUTE ON FUNCTION sweep_assistant_proposals () TO erp_runtime;

REVOKE CREATE ON SCHEMA public FROM erp_maintenance;
