-- The assistant (Task 24, September 2026). See docs/assistant/ARCHITECTURE.md.
--
-- The assistant reads and writes through the ordinary protected routes, signed
-- in as the person asking, so it needs no access of its own to any school
-- table. What it keeps is the conversation itself: whose it is, the sealed
-- words and tool results, and a count per question for the limits. The words
-- are sealed with the application key before they arrive here, and are
-- deleted 30 days after they were written.
--
-- A conversation is its owner's alone. Row-level security keeps it inside the
-- school; the assistant's queries always name the owner's membership as well,
-- and the security suite proves nobody else reads one, the owner included.
--
-- Also here: the `ai_assistant` consent purpose (a pupil uses the assistant
-- only after a guardian agrees) and `ai_assistant.use` as a restrictable key,
-- so an owner or principal can switch it off for one person.
--
-- Additive: the release before this one never reads the new tables.

-- One row per school. A school without a row has the defaults in
-- @erp/contracts (off, 50 and 20 a day, 3000 a month); the API writes the row
-- the first time it is saved.
CREATE TABLE assistant_settings (
    school_id uuid PRIMARY KEY REFERENCES schools (id) ON DELETE RESTRICT,
    enabled boolean NOT NULL DEFAULT FALSE,
    daily_questions_staff integer NOT NULL DEFAULT 50 CHECK (daily_questions_staff BETWEEN 0 AND 500),
    daily_questions_family integer NOT NULL DEFAULT 20 CHECK (daily_questions_family BETWEEN 0 AND 500),
    monthly_questions integer NOT NULL DEFAULT 3000 CHECK (monthly_questions BETWEEN 0 AND 100000),
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- One conversation. The title is the first words of the first question, so it
-- is sealed like the rest of the words.
CREATE TABLE assistant_threads (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    school_id uuid NOT NULL REFERENCES schools (id) ON DELETE CASCADE,
    membership_id uuid NOT NULL,
    title_sealed text,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_message_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (school_id, id),
    FOREIGN KEY (school_id, membership_id) REFERENCES school_memberships (school_id, id) ON DELETE CASCADE
);

CREATE INDEX assistant_threads_owner_idx ON assistant_threads (school_id, membership_id, last_message_at DESC);

-- One question or one answer, in the AI SDK's UI message shape, sealed as a
-- whole: the words, the tool calls and their results. message_key is the id
-- the browser and the SDK use for the message.
CREATE TABLE assistant_messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    school_id uuid NOT NULL REFERENCES schools (id) ON DELETE CASCADE,
    thread_id uuid NOT NULL,
    membership_id uuid NOT NULL,
    message_key text NOT NULL CHECK (message_key ~ '^[A-Za-z0-9_-]{1,128}$'),
    role text NOT NULL CHECK (role IN ('user', 'assistant')),
    content_sealed text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (school_id, thread_id, message_key),
    FOREIGN KEY (school_id, thread_id) REFERENCES assistant_threads (school_id, id) ON DELETE CASCADE
);

CREATE INDEX assistant_messages_thread_idx ON assistant_messages (school_id, thread_id, created_at);

CREATE INDEX assistant_messages_age_idx ON assistant_messages (created_at);

-- One row per question, written when the question starts so two questions at
-- once cannot both slip under a limit. No words: the roles the person held,
-- the school day it counts against, and what it cost.
CREATE TABLE assistant_usage (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    school_id uuid NOT NULL REFERENCES schools (id) ON DELETE CASCADE,
    membership_id uuid NOT NULL,
    role_keys text[] NOT NULL,
    -- The day in the school's timezone, for the per-person daily limit and the
    -- per-school monthly one.
    school_day date NOT NULL,
    status text NOT NULL DEFAULT 'started' CHECK (status IN ('started', 'answered', 'failed', 'stopped')),
    model text,
    tool_calls integer NOT NULL DEFAULT 0 CHECK (tool_calls >= 0),
    refused_calls integer NOT NULL DEFAULT 0 CHECK (refused_calls >= 0),
    input_tokens integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
    output_tokens integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    FOREIGN KEY (school_id, membership_id) REFERENCES school_memberships (school_id, id) ON DELETE CASCADE
);

CREATE INDEX assistant_usage_person_day_idx ON assistant_usage (school_id, membership_id, school_day);

CREATE INDEX assistant_usage_school_day_idx ON assistant_usage (school_id, school_day);

DO $$
DECLARE
    table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY['assistant_settings', 'assistant_threads', 'assistant_messages', 'assistant_usage']
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
        EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (school_id = NULLIF(current_setting(''app.school_id'', true), '''')::uuid) WITH CHECK (school_id = NULLIF(current_setting(''app.school_id'', true), '''')::uuid)', table_name);
    END LOOP;
END
$$;

REVOKE ALL ON assistant_settings, assistant_threads, assistant_messages, assistant_usage FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE ON assistant_settings TO erp_runtime;

-- A person deletes their own conversation; anonymising a pupil deletes theirs.
GRANT SELECT, INSERT, DELETE ON assistant_threads TO erp_runtime;

GRANT UPDATE (title_sealed, last_message_at) ON assistant_threads TO erp_runtime;

-- A message is written once. It goes with its thread or with the sweep.
GRANT SELECT, INSERT ON assistant_messages TO erp_runtime;

GRANT SELECT, INSERT ON assistant_usage TO erp_runtime;

GRANT UPDATE (status, model, tool_calls, refused_calls, input_tokens, output_tokens, finished_at) ON assistant_usage TO erp_runtime;

-- A pupil uses the assistant only after a guardian agrees.
ALTER TABLE guardian_consents
    DROP CONSTRAINT guardian_consents_purpose_check;

ALTER TABLE guardian_consents
    ADD CONSTRAINT guardian_consents_purpose_check CHECK (purpose IN ('education_records', 'health_information', 'photographs', 'communication', 'third_party_services', 'ai_assistant'));

-- Switching the assistant off for one person is a restriction, exactly like
-- taking sensitive details away: a school-target deny and never an allow.
CREATE OR REPLACE FUNCTION reject_bad_exception_permission ()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.target_type = 'school'
        AND NEW.permission IN ('students.read_sensitive', 'students.read_guardians', 'students.read_medical', 'ai_assistant.use') THEN
        IF NEW.effect <> 'deny' THEN
            RAISE EXCEPTION 'permission % can only be restricted', NEW.permission;
        END IF;
        RETURN NEW;
    END IF;
    IF (NEW.target_type = 'section' AND NEW.permission NOT IN ('students.read_basic', 'students.export', 'timetable.read')) OR (NEW.target_type = 'student' AND NEW.permission NOT IN ('students.read_basic')) OR (NEW.target_type = 'staff' AND NEW.permission NOT IN ('staff.read_directory')) OR (NEW.target_type = 'document' AND NEW.permission NOT IN ('students.read_documents', 'students.download_documents')) OR (NEW.target_type = 'school' AND NEW.permission NOT IN ('students.read_basic', 'students.export', 'staff.read_directory')) THEN
        RAISE EXCEPTION 'permission % is not supported for % exception target', NEW.permission, NEW.target_type;
    END IF;
    RETURN NEW;
END
$$;

-- Retention, run by the nightly sweep across every school. The rule from 0011:
-- the functions belong to erp_maintenance, which may only take them while it
-- holds CREATE on the schema, granted here and taken away at the end.
GRANT CREATE ON SCHEMA public TO erp_maintenance;

CREATE POLICY maintenance_sweep ON assistant_threads
    FOR ALL TO erp_maintenance
        USING (TRUE)
        WITH CHECK (TRUE);

CREATE POLICY maintenance_sweep ON assistant_messages
    FOR ALL TO erp_maintenance
        USING (TRUE)
        WITH CHECK (TRUE);

CREATE POLICY maintenance_sweep ON assistant_usage
    FOR ALL TO erp_maintenance
        USING (TRUE)
        WITH CHECK (TRUE);

GRANT SELECT, DELETE ON assistant_threads, assistant_messages, assistant_usage TO erp_maintenance;

-- Messages 30 days after they were written; a conversation once it has no
-- messages left and was last used more than 30 days ago; usage counts, which
-- hold no words, after 13 months.
CREATE FUNCTION sweep_assistant ()
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
    DELETE FROM public.assistant_messages
    WHERE created_at < now() - interval '30 days';
    GET DIAGNOSTICS removed = ROW_COUNT;
    item := 'assistant_messages';
    count := removed;
    RETURN NEXT;
    DELETE FROM public.assistant_threads AS thread
    WHERE thread.last_message_at < now() - interval '30 days'
        AND NOT EXISTS (
            SELECT
                1
            FROM
                public.assistant_messages AS msg
            WHERE
                msg.school_id = thread.school_id
                AND msg.thread_id = thread.id);
    GET DIAGNOSTICS removed = ROW_COUNT;
    item := 'assistant_threads';
    count := removed;
    RETURN NEXT;
    DELETE FROM public.assistant_usage
    WHERE created_at < now() - interval '13 months';
    GET DIAGNOSTICS removed = ROW_COUNT;
    item := 'assistant_usage';
    count := removed;
    RETURN NEXT;
END
$$;

ALTER FUNCTION sweep_assistant () OWNER TO erp_maintenance;

REVOKE ALL ON FUNCTION sweep_assistant () FROM PUBLIC;

GRANT EXECUTE ON FUNCTION sweep_assistant () TO erp_runtime;

REVOKE CREATE ON SCHEMA public FROM erp_maintenance;
