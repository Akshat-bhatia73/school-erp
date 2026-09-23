-- Task 22: communication.
--
-- A message is one announcement from the school: a notice a person wrote, or
-- one of the automatic messages the school sends by itself (an absence on the
-- day, results published, a report card published, fee dues, a birthday).
-- Families cannot reply. The words live once, on the message; who it went to
-- is one row per recipient, written when the message goes out, and that row is
-- the record of what happened to it: delivered, held back because the family
-- has not agreed to messages, and whether the email went and whether the
-- person opened it in the app.
--
-- The body is free text about children. It lives in this table and nowhere
-- else: never in a log, never in an audit row's safe_changes, never in the
-- delivery outbox. Anonymising a pupil or a staff member blanks the words of
-- every message that is about them.
--
-- The change is additive: five new tables, a policy and a grant that let the
-- maintenance role list school ids, four maintenance functions and one CHECK
-- constraint widened by one value. The release before this one keeps running
-- against it and never sees the new tables.
--
-- One row per school. A school without a row has the defaults below; the API
-- writes the row the first time it needs it. automatic_since is when automatic
-- messages started for the school, so a result published before it never
-- sends a notice long after the fact.
CREATE TABLE communication_settings (
    school_id uuid PRIMARY KEY REFERENCES schools (id) ON DELETE RESTRICT,
    absence_enabled boolean NOT NULL DEFAULT TRUE,
    -- How long after the register is saved the absence notice waits, so a
    -- teacher's correction a few minutes later stops a wrong notice.
    absence_delay_minutes integer NOT NULL DEFAULT 30 CHECK (absence_delay_minutes BETWEEN 0 AND 240),
    results_enabled boolean NOT NULL DEFAULT TRUE,
    report_cards_enabled boolean NOT NULL DEFAULT TRUE,
    fee_reminders_enabled boolean NOT NULL DEFAULT TRUE,
    fee_reminder_days_before integer NOT NULL DEFAULT 3 CHECK (fee_reminder_days_before BETWEEN 1 AND 30),
    -- 0 turns the overdue reminder off; otherwise one every so many days while
    -- anything is overdue.
    fee_overdue_every_days integer NOT NULL DEFAULT 7 CHECK (fee_overdue_every_days BETWEEN 0 AND 60),
    birthdays_pupils_enabled boolean NOT NULL DEFAULT TRUE,
    birthdays_staff_enabled boolean NOT NULL DEFAULT TRUE,
    -- The hour of the school day, in the school's timezone, from which the
    -- day's birthday wishes and fee reminders go out.
    daily_send_hour integer NOT NULL DEFAULT 8 CHECK (daily_send_hour BETWEEN 6 AND 12),
    automatic_since timestamptz NOT NULL DEFAULT now(),
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- The school's own wording. A `notice` template is a starting point a sender
-- picks; an automatic kind has at most one live template, which replaces the
-- built-in wording in @erp/contracts. Templates are archived, never deleted,
-- because a message names the template it started from.
CREATE TABLE message_templates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    school_id uuid NOT NULL REFERENCES schools (id) ON DELETE RESTRICT,
    kind text NOT NULL CHECK (kind IN ('notice', 'absence', 'result', 'report_card', 'fee_reminder', 'fee_overdue', 'birthday_pupil', 'birthday_staff')),
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
    title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 150),
    body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000),
    archived_at timestamptz,
    created_by_membership_id uuid NOT NULL,
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (school_id, id),
    FOREIGN KEY (school_id, created_by_membership_id) REFERENCES school_memberships (school_id, id)
);

CREATE UNIQUE INDEX message_templates_one_automatic_idx ON message_templates (school_id, kind)
WHERE
    kind <> 'notice' AND archived_at IS NULL;

-- One row per message. The audience says who it is for; the columns that
-- name a grade, a section, a pupil or a staff member are set exactly when the
-- audience needs them. A section message and a message about one pupil carry
-- the section and its year, which is how a teacher's assigned sections reach
-- it. created_by_membership_id is null for the school's automatic messages,
-- which carry a dedupe key instead so the same absence or birthday is never
-- sent twice.
CREATE TABLE messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    school_id uuid NOT NULL REFERENCES schools (id) ON DELETE RESTRICT,
    kind text NOT NULL CHECK (kind IN ('notice', 'absence', 'result', 'report_card', 'fee_reminder', 'fee_overdue', 'birthday_pupil', 'birthday_staff')),
    audience text NOT NULL CHECK (audience IN ('school', 'staff', 'grade', 'section', 'pupil', 'staff_member')),
    grade_id uuid,
    section_id uuid,
    academic_year_id uuid,
    student_id uuid,
    staff_id uuid,
    title text NOT NULL,
    body text NOT NULL,
    status text NOT NULL CHECK (status IN ('draft', 'scheduled', 'sent', 'withdrawn', 'cancelled')),
    send_at timestamptz,
    sent_at timestamptz,
    withdrawn_at timestamptz,
    withdrawn_by_membership_id uuid,
    cancelled_at timestamptz,
    cancel_reason text CHECK (cancel_reason IN ('author_lost_access')),
    created_by_membership_id uuid,
    template_id uuid,
    dedupe_key text,
    -- Set when anonymisation blanked the words; title and body are then ''.
    redacted_at timestamptz,
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (school_id, id),
    UNIQUE (school_id, dedupe_key),
    CHECK ((redacted_at IS NULL AND char_length(title) BETWEEN 1 AND 150 AND char_length(body) BETWEEN 1 AND 5000)
        OR (redacted_at IS NOT NULL AND title = '' AND body = '')),
    -- A person writes notices; the school writes everything else.
    CHECK ((kind = 'notice') = (created_by_membership_id IS NOT NULL)),
    CHECK ((kind = 'notice') = (dedupe_key IS NULL)),
    -- Automatic messages are about one pupil or one staff member.
    CHECK (kind = 'notice' OR (kind = 'birthday_staff' AND audience = 'staff_member') OR (kind <> 'birthday_staff' AND audience = 'pupil')),
    CHECK (audience <> 'staff_member' OR kind = 'birthday_staff'),
    CHECK ((section_id IS NULL) = (academic_year_id IS NULL)),
    CHECK ((audience IN ('school', 'staff') AND grade_id IS NULL AND section_id IS NULL AND student_id IS NULL AND staff_id IS NULL)
        OR (audience = 'grade' AND grade_id IS NOT NULL AND section_id IS NULL AND student_id IS NULL AND staff_id IS NULL)
        OR (audience = 'section' AND grade_id IS NULL AND section_id IS NOT NULL AND student_id IS NULL AND staff_id IS NULL)
        OR (audience = 'pupil' AND grade_id IS NULL AND student_id IS NOT NULL AND staff_id IS NULL)
        OR (audience = 'staff_member' AND grade_id IS NULL AND section_id IS NULL AND student_id IS NULL AND staff_id IS NOT NULL)),
    CHECK ((status = 'scheduled') <= (send_at IS NOT NULL)),
    CHECK ((status IN ('sent', 'withdrawn')) = (sent_at IS NOT NULL)),
    CHECK ((status = 'withdrawn') = (withdrawn_at IS NOT NULL)),
    CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL)),
    FOREIGN KEY (school_id, grade_id) REFERENCES grades (school_id, id),
    FOREIGN KEY (school_id, academic_year_id, section_id) REFERENCES sections (school_id, academic_year_id, id),
    FOREIGN KEY (school_id, student_id) REFERENCES students (school_id, id),
    FOREIGN KEY (school_id, staff_id) REFERENCES staff (school_id, id),
    FOREIGN KEY (school_id, created_by_membership_id) REFERENCES school_memberships (school_id, id),
    FOREIGN KEY (school_id, withdrawn_by_membership_id) REFERENCES school_memberships (school_id, id),
    FOREIGN KEY (school_id, template_id) REFERENCES message_templates (school_id, id)
);

CREATE INDEX messages_list_idx ON messages (school_id, status, COALESCE(sent_at, send_at, created_at) DESC);

CREATE INDEX messages_due_idx ON messages (school_id, send_at)
WHERE
    status = 'scheduled';

CREATE INDEX messages_student_idx ON messages (school_id, student_id)
WHERE
    student_id IS NOT NULL;

-- Once a message has gone out its words and its audience are the record of
-- what was said to whom. The only change allowed after that is the status
-- moving on (withdrawn), and anonymisation blanking the words. A message is
-- deleted only while it is a draft, or by the retention sweep.
CREATE FUNCTION messages_guard ()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status = 'draft' OR current_user = 'erp_maintenance' THEN
            RETURN OLD;
        END IF;
        RAISE EXCEPTION 'a message that has been sent or scheduled is kept'
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD.status IN ('sent', 'withdrawn', 'cancelled') THEN
        IF NEW.kind IS DISTINCT FROM OLD.kind
            OR NEW.audience IS DISTINCT FROM OLD.audience
            OR NEW.grade_id IS DISTINCT FROM OLD.grade_id
            OR NEW.section_id IS DISTINCT FROM OLD.section_id
            OR NEW.academic_year_id IS DISTINCT FROM OLD.academic_year_id
            OR NEW.student_id IS DISTINCT FROM OLD.student_id
            OR NEW.staff_id IS DISTINCT FROM OLD.staff_id
            OR NEW.sent_at IS DISTINCT FROM OLD.sent_at
            OR NEW.created_by_membership_id IS DISTINCT FROM OLD.created_by_membership_id
            OR NEW.dedupe_key IS DISTINCT FROM OLD.dedupe_key THEN
            RAISE EXCEPTION 'a message that has gone out cannot change'
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF (NEW.title IS DISTINCT FROM OLD.title OR NEW.body IS DISTINCT FROM OLD.body)
            AND NOT (NEW.redacted_at IS NOT NULL AND NEW.title = '' AND NEW.body = '') THEN
            RAISE EXCEPTION 'a message that has gone out cannot change'
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'sent' AND NEW.status = 'withdrawn') THEN
            RAISE EXCEPTION 'a message that has gone out cannot change'
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER messages_guard_update
    BEFORE UPDATE ON messages
    FOR EACH ROW
    EXECUTE FUNCTION messages_guard ();

CREATE TRIGGER messages_guard_delete
    BEFORE DELETE ON messages
    FOR EACH ROW
    EXECUTE FUNCTION messages_guard ();

-- A file sent with a message: bytes in the private document store, exactly as
-- a photograph is. The key is server state and never leaves the API. The
-- retention sweep blanks the key once the bytes are gone, then deletes the row
-- with its message.
CREATE TABLE message_attachments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    school_id uuid NOT NULL REFERENCES schools (id) ON DELETE RESTRICT,
    message_id uuid NOT NULL,
    file_name text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 120),
    content_type text NOT NULL CHECK (content_type IN ('application/pdf', 'image/jpeg', 'image/png')),
    size_bytes integer NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 2097152),
    storage_key text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (school_id, id),
    FOREIGN KEY (school_id, message_id) REFERENCES messages (school_id, id) ON DELETE CASCADE
);

CREATE INDEX message_attachments_message_idx ON message_attachments (school_id, message_id);

-- One row per person a message was for, written when it goes out. A family
-- member is a guardian, reached through a pupil (student_id, the first pupil
-- by name through whom they are in the audience); a staff member is reached
-- directly. membership_id is the portal account the message shows in, when
-- the person has one. section_id, academic_year_id and sender_membership_id
-- are copied from the message so a teacher's sections and the self scope
-- reach a row without a join.
CREATE TABLE message_recipients (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    school_id uuid NOT NULL REFERENCES schools (id) ON DELETE RESTRICT,
    message_id uuid NOT NULL,
    guardian_id uuid,
    staff_id uuid,
    membership_id uuid,
    student_id uuid,
    section_id uuid,
    academic_year_id uuid,
    sender_membership_id uuid,
    outcome text NOT NULL CHECK (outcome IN ('delivered', 'no_consent', 'not_receiving', 'no_contact')),
    in_app boolean NOT NULL,
    email_status text NOT NULL CHECK (email_status IN ('none', 'pending', 'sent', 'failed', 'cancelled')),
    -- The address as a person may see it ("r•••@gmail.com"), never the address.
    email_masked text,
    email_attempts integer NOT NULL DEFAULT 0 CHECK (email_attempts >= 0),
    email_next_attempt_at timestamptz,
    email_sent_at timestamptz,
    read_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (school_id, id),
    UNIQUE (school_id, message_id, guardian_id),
    UNIQUE (school_id, message_id, staff_id),
    CHECK ((guardian_id IS NULL) <> (staff_id IS NULL)),
    CHECK ((section_id IS NULL) = (academic_year_id IS NULL)),
    CHECK (outcome = 'delivered' OR (NOT in_app AND email_status = 'none')),
    CHECK (in_app <= (membership_id IS NOT NULL)),
    CHECK (read_at IS NULL OR in_app),
    CHECK ((email_status = 'sent') = (email_sent_at IS NOT NULL)),
    FOREIGN KEY (school_id, message_id) REFERENCES messages (school_id, id) ON DELETE CASCADE,
    FOREIGN KEY (school_id, guardian_id) REFERENCES guardians (school_id, id),
    FOREIGN KEY (school_id, staff_id) REFERENCES staff (school_id, id),
    FOREIGN KEY (school_id, membership_id) REFERENCES school_memberships (school_id, id),
    FOREIGN KEY (school_id, student_id) REFERENCES students (school_id, id),
    FOREIGN KEY (school_id, academic_year_id, section_id) REFERENCES sections (school_id, academic_year_id, id)
);

CREATE INDEX message_recipients_message_idx ON message_recipients (school_id, message_id);

CREATE INDEX message_recipients_inbox_idx ON message_recipients (school_id, membership_id, created_at DESC)
WHERE
    in_app;

CREATE INDEX message_recipients_email_due_idx ON message_recipients (school_id, email_next_attempt_at)
WHERE
    email_status = 'pending';

DO $$
DECLARE
    table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY['communication_settings', 'message_templates', 'messages', 'message_attachments', 'message_recipients']
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
        EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (school_id = NULLIF(current_setting(''app.school_id'', true), '''')::uuid) WITH CHECK (school_id = NULLIF(current_setting(''app.school_id'', true), '''')::uuid)', table_name);
    END LOOP;
END
$$;

REVOKE ALL ON communication_settings, message_templates, messages, message_attachments, message_recipients FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE ON communication_settings, message_templates TO erp_runtime;

-- A draft can be deleted; the trigger refuses every other delete.
GRANT SELECT, INSERT, UPDATE, DELETE ON messages TO erp_runtime;

GRANT SELECT, INSERT, DELETE ON message_attachments TO erp_runtime;

-- A recipient row is written once; afterwards only the email's progress and
-- the read receipt move, plus the masked address, which anonymisation clears.
GRANT SELECT, INSERT ON message_recipients TO erp_runtime;

GRANT UPDATE (email_status, email_masked, email_attempts, email_next_attempt_at, email_sent_at, read_at) ON message_recipients TO erp_runtime;

-- The maintenance side. The rule from 0011: ownership moves to
-- erp_maintenance below, and a non-superuser migrator can only do that while
-- the new owner holds CREATE on the schema. It is granted here and taken away
-- again at the end of this file.
GRANT CREATE ON SCHEMA public TO erp_maintenance;

-- The automatic messages and the email queue are worked through school by
-- school, so the cron route needs the list of school ids and nothing else.
CREATE POLICY maintenance_list ON schools
    FOR SELECT TO erp_maintenance
        USING (TRUE);

GRANT SELECT (id) ON schools TO erp_maintenance;

CREATE FUNCTION list_message_schools ()
    RETURNS TABLE (
        school_id uuid)
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = pg_catalog,
    public
    AS $$
    SELECT
        id
    FROM
        public.schools
    ORDER BY
        id;
$$;

ALTER FUNCTION list_message_schools () OWNER TO erp_maintenance;

REVOKE ALL ON FUNCTION list_message_schools () FROM PUBLIC;

GRANT EXECUTE ON FUNCTION list_message_schools () TO erp_runtime;

-- Retention. A message and its delivery record are kept for two years after
-- it went out (or was withdrawn or cancelled); a draft nobody has touched for
-- a year goes too. Files before rows, as for export files: the route removes
-- the bytes of every attachment listed here, blanks each key with
-- forget_message_attachment (), and then sweep_messages () deletes the
-- messages that no longer name any bytes.
CREATE POLICY maintenance_sweep ON messages
    FOR ALL TO erp_maintenance
        USING (TRUE)
        WITH CHECK (TRUE);

CREATE POLICY maintenance_sweep ON message_attachments
    FOR ALL TO erp_maintenance
        USING (TRUE)
        WITH CHECK (TRUE);

CREATE POLICY maintenance_sweep ON message_recipients
    FOR ALL TO erp_maintenance
        USING (TRUE)
        WITH CHECK (TRUE);

GRANT SELECT, DELETE ON messages, message_recipients TO erp_maintenance;

GRANT SELECT, UPDATE (storage_key), DELETE ON message_attachments TO erp_maintenance;

CREATE FUNCTION message_expired (status text, sent_at timestamptz, withdrawn_at timestamptz, cancelled_at timestamptz, updated_at timestamptz)
    RETURNS boolean
    LANGUAGE sql
    STABLE
    SET search_path = pg_catalog
    AS $$
    SELECT
        CASE WHEN status IN ('sent', 'withdrawn', 'cancelled') THEN
            COALESCE(withdrawn_at, cancelled_at, sent_at, updated_at) < now() - interval '2 years'
        WHEN status = 'draft' THEN
            updated_at < now() - interval '1 year'
        ELSE
            FALSE
        END;
$$;

CREATE FUNCTION list_expired_message_attachments ()
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
        att.school_id,
        att.id,
        att.storage_key
    FROM
        public.message_attachments AS att
        JOIN public.messages AS msg ON msg.school_id = att.school_id
            AND msg.id = att.message_id
    WHERE
        att.storage_key <> ''
        AND public.message_expired (msg.status, msg.sent_at, msg.withdrawn_at, msg.cancelled_at, msg.updated_at)
    ORDER BY
        att.created_at
    LIMIT 1000;
$$;

ALTER FUNCTION list_expired_message_attachments () OWNER TO erp_maintenance;

REVOKE ALL ON FUNCTION list_expired_message_attachments () FROM PUBLIC;

GRANT EXECUTE ON FUNCTION list_expired_message_attachments () TO erp_runtime;

CREATE FUNCTION forget_message_attachment (target_school uuid, target_id uuid)
    RETURNS void
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = pg_catalog,
    public
    AS $$
    UPDATE
        public.message_attachments
    SET
        storage_key = ''
    WHERE
        school_id = target_school
        AND id = target_id;
$$;

ALTER FUNCTION forget_message_attachment (uuid, uuid) OWNER TO erp_maintenance;

REVOKE ALL ON FUNCTION forget_message_attachment (uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION forget_message_attachment (uuid, uuid) TO erp_runtime;

CREATE FUNCTION sweep_messages ()
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
    DELETE FROM public.messages AS msg
    WHERE public.message_expired (msg.status, msg.sent_at, msg.withdrawn_at, msg.cancelled_at, msg.updated_at)
        AND NOT EXISTS (
            SELECT
                1
            FROM
                public.message_attachments AS att
            WHERE
                att.school_id = msg.school_id
                AND att.message_id = msg.id
                AND att.storage_key <> '');
    GET DIAGNOSTICS removed = ROW_COUNT;
    item := 'messages';
    count := removed;
    RETURN NEXT;
END
$$;

ALTER FUNCTION sweep_messages () OWNER TO erp_maintenance;

REVOKE ALL ON FUNCTION sweep_messages () FROM PUBLIC;

GRANT EXECUTE ON FUNCTION sweep_messages () TO erp_runtime;

REVOKE CREATE ON SCHEMA public FROM erp_maintenance;

-- One new kind of export file: the delivery record of one message.
ALTER TABLE export_jobs
    DROP CONSTRAINT export_jobs_kind_check;

ALTER TABLE export_jobs
    ADD CONSTRAINT export_jobs_kind_check CHECK (kind IN ('students', 'staff', 'audit', 'student_profile', 'staff_profile', 'timetable', 'fee_receipt', 'fee_dues', 'fee_collections', 'attendance_register', 'attendance_pupil_month', 'staff_attendance_register', 'exam_marks_register', 'report_card', 'report_cards_section', 'message_delivery'));
