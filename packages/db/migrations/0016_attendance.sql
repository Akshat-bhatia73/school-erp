-- Task 20: attendance.
--
-- Two tables, one for pupils and one for staff. Every row is an event and
-- none is ever edited or removed: the current mark for a pupil (or a staff
-- member) on a date is the row with the highest revision, and a later save or
-- an office correction is a new row that points at the row it supersedes
-- through supersedes_entry_id. The database refuses UPDATE and DELETE by
-- trigger and by grant, so a handler bug cannot rewrite history either.
--
-- The reason somebody typed for a correction is never a column here: it is
-- the note on the audit row, which can be redacted.
--
-- The change is additive: two new tables and one CHECK constraint widened by
-- three values. The release before this one keeps running against it and
-- never sees the new tables.
--
-- One mark per pupil, per date, per revision. The section and the academic
-- year travel together through the composite foreign key, so a mark can never
-- name a section in another year, let alone another school.
CREATE TABLE attendance_entries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    school_id uuid NOT NULL REFERENCES schools (id) ON DELETE RESTRICT,
    student_id uuid NOT NULL,
    section_id uuid NOT NULL,
    academic_year_id uuid NOT NULL,
    date date NOT NULL,
    mark text NOT NULL CHECK (mark IN ('present', 'absent', 'late', 'leave', 'half_day')),
    -- 1 for the first mark of a pupil on a date, then one more per row that
    -- supersedes it. The unique index below is what makes "the newest row"
    -- unambiguous: two rows can never share a revision.
    revision integer NOT NULL CHECK (revision > 0),
    supersedes_entry_id uuid,
    -- 'marking' is a row written by whoever marks the register (the class
    -- teacher, or the office marking a day that was never marked);
    -- 'correction' is a row the office wrote with a reason.
    kind text NOT NULL CHECK (kind IN ('marking', 'correction')),
    recorded_by_membership_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (school_id, id),
    UNIQUE (school_id, student_id, date, revision),
    CHECK ((revision = 1) = (supersedes_entry_id IS NULL)),
    FOREIGN KEY (school_id, student_id) REFERENCES students (school_id, id),
    FOREIGN KEY (school_id, academic_year_id, section_id) REFERENCES sections (school_id, academic_year_id, id),
    FOREIGN KEY (school_id, supersedes_entry_id) REFERENCES attendance_entries (school_id, id),
    FOREIGN KEY (school_id, recorded_by_membership_id) REFERENCES school_memberships (school_id, id)
);

CREATE INDEX attendance_entries_section_date_idx ON attendance_entries (school_id, section_id, date);

CREATE INDEX attendance_entries_student_date_idx ON attendance_entries (school_id, student_id, date);

-- One mark per staff member, per date, per revision, kept the same way.
CREATE TABLE staff_attendance_entries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    school_id uuid NOT NULL REFERENCES schools (id) ON DELETE RESTRICT,
    staff_id uuid NOT NULL,
    date date NOT NULL,
    mark text NOT NULL CHECK (mark IN ('present', 'absent', 'late', 'leave', 'half_day')),
    revision integer NOT NULL CHECK (revision > 0),
    supersedes_entry_id uuid,
    kind text NOT NULL CHECK (kind IN ('marking', 'correction')),
    recorded_by_membership_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (school_id, id),
    UNIQUE (school_id, staff_id, date, revision),
    CHECK ((revision = 1) = (supersedes_entry_id IS NULL)),
    FOREIGN KEY (school_id, staff_id) REFERENCES staff (school_id, id),
    FOREIGN KEY (school_id, supersedes_entry_id) REFERENCES staff_attendance_entries (school_id, id),
    FOREIGN KEY (school_id, recorded_by_membership_id) REFERENCES school_memberships (school_id, id)
);

CREATE INDEX staff_attendance_entries_date_idx ON staff_attendance_entries (school_id, date);

CREATE INDEX staff_attendance_entries_staff_date_idx ON staff_attendance_entries (school_id, staff_id, date);

-- Append-only in the database, not only in the API. Every UPDATE and every
-- DELETE is refused, whoever asks. A correction is a new row.
CREATE FUNCTION attendance_entries_immutable ()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'attendance entries are append-only';
END
$$;

CREATE TRIGGER attendance_entries_no_change
    BEFORE UPDATE OR DELETE ON attendance_entries
    FOR EACH ROW
    EXECUTE FUNCTION attendance_entries_immutable ();

CREATE TRIGGER staff_attendance_entries_no_change
    BEFORE UPDATE OR DELETE ON staff_attendance_entries
    FOR EACH ROW
    EXECUTE FUNCTION attendance_entries_immutable ();

DO $$
DECLARE
    table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY['attendance_entries', 'staff_attendance_entries']
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
        EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (school_id = NULLIF(current_setting(''app.school_id'', true), '''')::uuid) WITH CHECK (school_id = NULLIF(current_setting(''app.school_id'', true), '''')::uuid)', table_name);
    END LOOP;
END
$$;

REVOKE ALL ON attendance_entries, staff_attendance_entries FROM PUBLIC;

-- Read and append. No UPDATE and no DELETE, for anybody the API runs as.
GRANT SELECT, INSERT ON attendance_entries, staff_attendance_entries TO erp_runtime;

-- Three new kinds of export file: a section's monthly register, one pupil's
-- month as a document, and the staff register for a month.
ALTER TABLE export_jobs
    DROP CONSTRAINT export_jobs_kind_check;

ALTER TABLE export_jobs
    ADD CONSTRAINT export_jobs_kind_check CHECK (kind IN ('students', 'staff', 'audit', 'student_profile', 'staff_profile', 'timetable', 'fee_receipt', 'fee_dues', 'fee_collections', 'attendance_register', 'attendance_pupil_month', 'staff_attendance_register'));
