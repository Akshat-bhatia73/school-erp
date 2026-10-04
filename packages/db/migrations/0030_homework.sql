-- Task 25: homework.
--
-- Decided by the product owner on 4 October 2026:
--  * a homework item belongs to one section in one academic year, with a
--    subject (a subject teacher's) or none (the class teacher's general
--    homework for their own class);
--  * it is set today (in the school's timezone) and due on or after that day,
--    within 60 days; editing changes the words, the due date and the files,
--    never the section or the subject;
--  * removing hides it from families and drops it from figures but keeps it
--    and its check-offs; nothing is deleted by a person;
--  * up to three files, PDF, JPEG or PNG, 4 MB each, in the private document
--    store exactly like message attachments;
--  * from the due date the teacher marks each pupil on the roster done,
--    partly done or not done with an optional remark of up to 200 characters.
--
-- Retention: an item and its files are school records about a class, kept for
-- the academic year they belong to and one more, then removed by the nightly
-- sweep. A pupil's check-offs are part of the pupil's record: they outlive
-- the item (homework_id is set to NULL when the sweep removes it) and keep
-- the section, year and subject they were made in, so the scope predicates
-- still read them off the row. Anonymising the pupil clears the remarks.
--
-- The change is additive: three new tables, two settings columns, one
-- grant and policy that let the sweep read when a year ended, three
-- maintenance functions and four CHECK constraints widened by one value. The
-- release before this one keeps running against it and never sends the new
-- kind.
CREATE TABLE homework (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    school_id uuid NOT NULL REFERENCES schools (id) ON DELETE RESTRICT,
    academic_year_id uuid NOT NULL,
    section_id uuid NOT NULL,
    -- NULL is general homework: the class teacher's, for the whole class.
    subject_id uuid,
    title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
    -- Free text about a class, never copied into an audit row. May be empty
    -- when the title says it all.
    instructions text NOT NULL DEFAULT '' CHECK (char_length(instructions) <= 4000),
    set_on date NOT NULL,
    due_on date NOT NULL,
    created_by_membership_id uuid NOT NULL,
    -- The author's staff record when they have one; the office may not.
    created_by_staff_id uuid,
    updated_by_membership_id uuid NOT NULL,
    removed_at timestamptz,
    removed_by_membership_id uuid,
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (school_id, id),
    -- What a check-off points at, so a check-off always agrees with its item.
    UNIQUE (school_id, id, academic_year_id, section_id),
    CHECK (due_on >= set_on),
    CHECK (due_on <= set_on + 60),
    CHECK ((removed_at IS NULL) = (removed_by_membership_id IS NULL)),
    FOREIGN KEY (school_id, academic_year_id, section_id) REFERENCES sections (school_id, academic_year_id, id),
    FOREIGN KEY (school_id, subject_id) REFERENCES subjects (school_id, id),
    FOREIGN KEY (school_id, created_by_membership_id) REFERENCES school_memberships (school_id, id),
    FOREIGN KEY (school_id, created_by_staff_id) REFERENCES staff (school_id, id),
    FOREIGN KEY (school_id, updated_by_membership_id) REFERENCES school_memberships (school_id, id),
    FOREIGN KEY (school_id, removed_by_membership_id) REFERENCES school_memberships (school_id, id)
);

CREATE INDEX homework_section_due_idx ON homework (school_id, section_id, due_on);

CREATE INDEX homework_year_due_idx ON homework (school_id, academic_year_id, due_on);

-- The evening digest looks for the items set on one day.
CREATE INDEX homework_set_on_idx ON homework (school_id, set_on)
WHERE
    removed_at IS NULL;

-- A file set with an item: bytes in the private document store, exactly as a
-- message attachment is. The key is server state and never leaves the API.
-- The API allows three per item. The retention sweep blanks the key once the
-- bytes are gone, then deletes the row with its item.
CREATE TABLE homework_attachments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    school_id uuid NOT NULL REFERENCES schools (id) ON DELETE RESTRICT,
    homework_id uuid NOT NULL,
    file_name text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 120),
    content_type text NOT NULL CHECK (content_type IN ('application/pdf', 'image/jpeg', 'image/png')),
    size_bytes integer NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 4194304),
    storage_key text NOT NULL,
    created_by_membership_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (school_id, id),
    FOREIGN KEY (school_id, homework_id) REFERENCES homework (school_id, id) ON DELETE CASCADE,
    FOREIGN KEY (school_id, created_by_membership_id) REFERENCES school_memberships (school_id, id)
);

CREATE INDEX homework_attachments_homework_idx ON homework_attachments (school_id, homework_id);

-- One check-off per pupil and item: the teacher's status, the only one there
-- is. A pupil on the roster with no row after the due date is "not checked",
-- never "not done". The section and the year are copied from the item through
-- one composite foreign key and the subject is checked by the trigger below,
-- so the scope predicates read them off the row and they never disagree.
-- When the sweep removes the item, homework_id becomes NULL and the row stays
-- with the pupil's record.
CREATE TABLE homework_checks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    school_id uuid NOT NULL REFERENCES schools (id) ON DELETE RESTRICT,
    homework_id uuid,
    student_id uuid NOT NULL,
    academic_year_id uuid NOT NULL,
    section_id uuid NOT NULL,
    subject_id uuid,
    status text NOT NULL CHECK (status IN ('done', 'partly_done', 'not_done')),
    -- Free text about a child. Cleared when the pupil is anonymised, and never
    -- copied into an audit row's safe_changes.
    remark text CHECK (remark IS NULL OR char_length(remark) BETWEEN 1 AND 200),
    checked_by_membership_id uuid NOT NULL,
    checked_at timestamptz NOT NULL DEFAULT now(),
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (school_id, id),
    UNIQUE (school_id, homework_id, student_id),
    FOREIGN KEY (school_id, homework_id, academic_year_id, section_id) REFERENCES homework (school_id, id, academic_year_id, section_id) ON DELETE SET NULL (homework_id),
    FOREIGN KEY (school_id, student_id) REFERENCES students (school_id, id),
    FOREIGN KEY (school_id, academic_year_id, section_id) REFERENCES sections (school_id, academic_year_id, id),
    FOREIGN KEY (school_id, subject_id) REFERENCES subjects (school_id, id),
    FOREIGN KEY (school_id, checked_by_membership_id) REFERENCES school_memberships (school_id, id)
);

CREATE INDEX homework_checks_student_idx ON homework_checks (school_id, student_id);

CREATE INDEX homework_checks_section_idx ON homework_checks (school_id, section_id, academic_year_id);

-- An item keeps its class, its subject, the day it was set and its author.
-- Only the retention sweep deletes one.
CREATE FUNCTION homework_guard ()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF current_user = 'erp_maintenance' THEN
            RETURN OLD;
        END IF;
        RAISE EXCEPTION 'homework is removed, never deleted'
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.school_id IS DISTINCT FROM OLD.school_id
        OR NEW.academic_year_id IS DISTINCT FROM OLD.academic_year_id
        OR NEW.section_id IS DISTINCT FROM OLD.section_id
        OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
        OR NEW.set_on IS DISTINCT FROM OLD.set_on
        OR NEW.created_by_membership_id IS DISTINCT FROM OLD.created_by_membership_id
        OR NEW.created_by_staff_id IS DISTINCT FROM OLD.created_by_staff_id
        OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'the class, subject and author of homework never change'
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    -- Removing is for good, and a removed item is kept exactly as it was:
    -- not un-removed, not edited, not re-versioned. Removing itself starts
    -- from OLD.removed_at IS NULL, so it passes.
    IF OLD.removed_at IS NOT NULL THEN
        RAISE EXCEPTION 'removed homework stays as it was'
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER homework_guard_update
    BEFORE UPDATE ON homework
    FOR EACH ROW
    EXECUTE FUNCTION homework_guard ();

CREATE TRIGGER homework_guard_delete
    BEFORE DELETE ON homework
    FOR EACH ROW
    EXECUTE FUNCTION homework_guard ();

-- A check-off names the item's subject, and keeps its pupil and its class.
-- The one change of homework_id allowed is to NULL, which is what the sweep's
-- foreign key action does when the item goes. The check-offs of a removed
-- item are kept as they were: none is written or changed, except that
-- anonymising the pupil clears a remark (a change of the remark to NULL, the
-- version and updated_at, and nothing else).
CREATE FUNCTION homework_checks_guard ()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    item_subject uuid;
    item_removed timestamptz;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW.school_id IS DISTINCT FROM OLD.school_id
            OR NEW.student_id IS DISTINCT FROM OLD.student_id
            OR NEW.academic_year_id IS DISTINCT FROM OLD.academic_year_id
            OR NEW.section_id IS DISTINCT FROM OLD.section_id
            OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
            OR (NEW.homework_id IS DISTINCT FROM OLD.homework_id AND NEW.homework_id IS NOT NULL) THEN
            RAISE EXCEPTION 'a check-off keeps its pupil, its item and its class'
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW.homework_id IS NULL THEN
            RETURN NEW;
        END IF;
        SELECT
            h.removed_at INTO item_removed
        FROM
            homework h
        WHERE
            h.school_id = NEW.school_id
            AND h.id = NEW.homework_id;
        IF item_removed IS NOT NULL AND NOT (NEW.remark IS NULL
                AND NEW.status IS NOT DISTINCT FROM OLD.status
                AND NEW.checked_by_membership_id IS NOT DISTINCT FROM OLD.checked_by_membership_id
                AND NEW.checked_at IS NOT DISTINCT FROM OLD.checked_at) THEN
            RAISE EXCEPTION 'the check-offs of removed homework stay as they were'
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.homework_id IS NULL THEN
        RAISE EXCEPTION 'a check-off is written for an item'
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    SELECT
        h.subject_id,
        h.removed_at INTO item_subject,
        item_removed
    FROM
        homework h
    WHERE
        h.school_id = NEW.school_id
        AND h.id = NEW.homework_id;
    IF item_removed IS NOT NULL THEN
        RAISE EXCEPTION 'the check-offs of removed homework stay as they were'
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF FOUND AND item_subject IS DISTINCT FROM NEW.subject_id THEN
        RAISE EXCEPTION 'a check-off names the subject of its item'
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER homework_checks_guard
    BEFORE INSERT OR UPDATE ON homework_checks
    FOR EACH ROW
    EXECUTE FUNCTION homework_checks_guard ();

-- The files of a removed item are kept as they were: none is added, and the
-- API never deletes one. The retention sweep (erp_maintenance, or the foreign
-- key cascade when it deletes the item) is not the API and passes.
CREATE FUNCTION homework_attachments_guard ()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    target_school uuid;
    target_item uuid;
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF current_user <> 'erp_runtime' THEN
            RETURN OLD;
        END IF;
        target_school := OLD.school_id;
        target_item := OLD.homework_id;
    ELSE
        target_school := NEW.school_id;
        target_item := NEW.homework_id;
    END IF;
    IF EXISTS (
        SELECT
            1
        FROM
            homework h
        WHERE
            h.school_id = target_school
            AND h.id = target_item
            AND h.removed_at IS NOT NULL) THEN
        RAISE EXCEPTION 'the files of removed homework stay as they were'
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER homework_attachments_guard
    BEFORE INSERT OR DELETE ON homework_attachments
    FOR EACH ROW
    EXECUTE FUNCTION homework_attachments_guard ();

DO $$
DECLARE
    table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY['homework', 'homework_attachments', 'homework_checks']
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
        EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (school_id = NULLIF(current_setting(''app.school_id'', true), '''')::uuid) WITH CHECK (school_id = NULLIF(current_setting(''app.school_id'', true), '''')::uuid)', table_name);
    END LOOP;
END
$$;

REVOKE ALL ON homework, homework_attachments, homework_checks FROM PUBLIC;

-- Set, edit and remove. No DELETE for anybody the API runs as.
GRANT SELECT, INSERT, UPDATE ON homework TO erp_runtime;

-- A file taken off an item during an edit is deleted with its bytes.
GRANT SELECT, INSERT, DELETE ON homework_attachments TO erp_runtime;

-- Checked and changed, and the remark cleared by anonymisation; never deleted.
GRANT SELECT, INSERT ON homework_checks TO erp_runtime;

GRANT UPDATE (status, remark, checked_by_membership_id, checked_at, version, updated_at) ON homework_checks TO erp_runtime;

-- The evening digest: one per pupil per day that had homework set, to the
-- families, under the same consent and notification rules as every automatic
-- message. It goes from homework_digest_time ('HH:MM' in the school's
-- timezone, 12:00 to 21:00) until 09:00 the next morning, then is skipped.
ALTER TABLE communication_settings
    ADD COLUMN homework_digest_enabled boolean NOT NULL DEFAULT TRUE,
    ADD COLUMN homework_digest_time text NOT NULL DEFAULT '17:00' CHECK (homework_digest_time ~ '^(1[2-9]|20):[0-5][0-9]$'
        OR homework_digest_time = '21:00');

ALTER TABLE message_templates
    DROP CONSTRAINT message_templates_kind_check;

ALTER TABLE message_templates
    ADD CONSTRAINT message_templates_kind_check CHECK (kind IN ('notice', 'absence', 'result', 'report_card', 'fee_reminder', 'fee_overdue', 'birthday_pupil', 'birthday_staff', 'leave_decision_pupil', 'leave_decision_staff', 'homework_digest'));

ALTER TABLE messages
    DROP CONSTRAINT messages_kind_check;

-- The digest is about one pupil (audience 'pupil') and goes to the families
-- (recipients 'families'): messages_audience_by_kind_check and
-- messages_automatic_recipients_check from 0029 already say exactly that for
-- every kind they do not name, so they stay as they are.
ALTER TABLE messages
    ADD CONSTRAINT messages_kind_check CHECK (kind IN ('notice', 'absence', 'result', 'report_card', 'fee_reminder', 'fee_overdue', 'birthday_pupil', 'birthday_staff', 'leave_decision_pupil', 'leave_decision_staff', 'homework_digest'));

-- One new kind of export file: the office's homework report.
ALTER TABLE export_jobs
    DROP CONSTRAINT export_jobs_kind_check;

ALTER TABLE export_jobs
    ADD CONSTRAINT export_jobs_kind_check CHECK (kind IN ('students', 'staff', 'audit', 'student_profile', 'staff_profile', 'timetable', 'fee_receipt', 'fee_dues', 'fee_collections', 'attendance_register', 'attendance_pupil_month', 'staff_attendance_register', 'exam_marks_register', 'report_card', 'report_cards_section', 'message_delivery', 'homework_report'));

-- Retention, the maintenance side. Files before rows, as for message
-- attachments: the route removes the bytes of every file listed by
-- list_expired_homework_attachments (), blanks each key with
-- forget_homework_attachment (), and then sweep_homework () deletes the
-- expired items that no longer name any bytes. An item expires once the
-- academic year after its own has ended: its year's last day is more than a
-- year ago. The rule from 0011: ownership moves to erp_maintenance only
-- while it holds CREATE on the schema.
GRANT CREATE ON SCHEMA public TO erp_maintenance;

CREATE POLICY maintenance_sweep ON homework
    FOR ALL TO erp_maintenance
        USING (TRUE)
        WITH CHECK (TRUE);

CREATE POLICY maintenance_sweep ON homework_attachments
    FOR ALL TO erp_maintenance
        USING (TRUE)
        WITH CHECK (TRUE);

-- When a year ended, and nothing else about it.
CREATE POLICY maintenance_read ON academic_years
    FOR SELECT TO erp_maintenance
        USING (TRUE);

GRANT SELECT (school_id, id, end_date) ON academic_years TO erp_maintenance;

GRANT SELECT, DELETE ON homework TO erp_maintenance;

GRANT SELECT, UPDATE (storage_key), DELETE ON homework_attachments TO erp_maintenance;

CREATE FUNCTION list_expired_homework_attachments ()
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
        public.homework_attachments AS att
        JOIN public.homework AS hw ON hw.school_id = att.school_id
            AND hw.id = att.homework_id
        JOIN public.academic_years AS ay ON ay.school_id = hw.school_id
            AND ay.id = hw.academic_year_id
    WHERE
        att.storage_key <> ''
        AND ay.end_date < (now() - interval '1 year')::date
    ORDER BY
        att.created_at
    LIMIT 1000;
$$;

ALTER FUNCTION list_expired_homework_attachments () OWNER TO erp_maintenance;

REVOKE ALL ON FUNCTION list_expired_homework_attachments () FROM PUBLIC;

GRANT EXECUTE ON FUNCTION list_expired_homework_attachments () TO erp_runtime;

CREATE FUNCTION forget_homework_attachment (target_school uuid, target_id uuid)
    RETURNS void
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = pg_catalog,
    public
    AS $$
    UPDATE
        public.homework_attachments
    SET
        storage_key = ''
    WHERE
        school_id = target_school
        AND id = target_id;
$$;

ALTER FUNCTION forget_homework_attachment (uuid, uuid) OWNER TO erp_maintenance;

REVOKE ALL ON FUNCTION forget_homework_attachment (uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION forget_homework_attachment (uuid, uuid) TO erp_runtime;

CREATE FUNCTION sweep_homework ()
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
    -- The check-offs stay: their foreign key sets homework_id to NULL.
    DELETE FROM public.homework AS hw USING public.academic_years AS ay
    WHERE ay.school_id = hw.school_id
        AND ay.id = hw.academic_year_id
        AND ay.end_date < (now() - interval '1 year')::date
        AND NOT EXISTS (
            SELECT
                1
            FROM
                public.homework_attachments AS att
            WHERE
                att.school_id = hw.school_id
                AND att.homework_id = hw.id
                AND att.storage_key <> '');
    GET DIAGNOSTICS removed = ROW_COUNT;
    item := 'homework';
    count := removed;
    RETURN NEXT;
END
$$;

ALTER FUNCTION sweep_homework () OWNER TO erp_maintenance;

REVOKE ALL ON FUNCTION sweep_homework () FROM PUBLIC;

GRANT EXECUTE ON FUNCTION sweep_homework () TO erp_runtime;

REVOKE CREATE ON SCHEMA public FROM erp_maintenance;
