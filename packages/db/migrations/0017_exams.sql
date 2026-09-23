-- Task 21: exams and report cards.
--
-- The exam pattern itself is not here. Every school follows the CBSE two-term
-- scheme, and the pattern (which exams, which components, what each is out
-- of) is a constant in @erp/contracts. What a school sets is when each exam
-- happens and when its re-check window closes, and those are rows.
--
-- Marks are events, exactly as attendance marks are: a save or a correction
-- is a new row that supersedes the one before it, the current mark is the
-- highest revision, and the database refuses UPDATE and DELETE. A publication
-- is an event too, and a report card version is a frozen copy of what was
-- published. The reason somebody typed for a change is never a column: it is
-- the note on the audit row, which can be redacted.
--
-- The change is additive: seven new tables, three new columns on schools and
-- one CHECK constraint widened by three values. The release before this one
-- keeps running against it and never sees the new tables.
--
-- One row per academic year and exam. The term is a property of the kind (the
-- first two are term 1, the last two term 2), so it is not stored twice.
CREATE TABLE exams (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    school_id uuid NOT NULL REFERENCES schools (id) ON DELETE RESTRICT,
    academic_year_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('periodic_test_1', 'half_yearly', 'periodic_test_2', 'annual')),
    starts_on date NOT NULL,
    ends_on date NOT NULL,
    -- The last day on which the subject teacher may still change a mark. The
    -- window closes at the end of this day in the school's timezone; nothing
    -- runs at that moment, the API works it out from the date.
    recheck_deadline date NOT NULL,
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (school_id, id),
    UNIQUE (school_id, academic_year_id, id),
    UNIQUE (school_id, academic_year_id, kind),
    CHECK (starts_on <= ends_on),
    CHECK (ends_on <= recheck_deadline),
    FOREIGN KEY (school_id, academic_year_id) REFERENCES academic_years (school_id, id)
);

-- One row per exam, section and subject: the sheet a subject teacher fills
-- in. The office's save of an exam brings the papers up to date with the
-- sections of that year and the subjects of their class (grade_subjects).
-- The section and the exam carry the same academic year, so a paper can never
-- join an exam to a section of another year.
CREATE TABLE exam_papers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    school_id uuid NOT NULL REFERENCES schools (id) ON DELETE RESTRICT,
    exam_id uuid NOT NULL,
    academic_year_id uuid NOT NULL,
    section_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (school_id, id),
    UNIQUE (school_id, exam_id, section_id, subject_id),
    -- What a mark row points at, so a mark always agrees with its paper.
    UNIQUE (school_id, id, exam_id, academic_year_id, section_id, subject_id),
    FOREIGN KEY (school_id, academic_year_id, exam_id) REFERENCES exams (school_id, academic_year_id, id),
    FOREIGN KEY (school_id, academic_year_id, section_id) REFERENCES sections (school_id, academic_year_id, id),
    FOREIGN KEY (school_id, subject_id) REFERENCES subjects (school_id, id)
);

CREATE INDEX exam_papers_section_idx ON exam_papers (school_id, section_id);

-- One mark per pupil, paper, component and revision. A mark is a whole
-- number of tenths (so 7.5 out of 10 is 75), or one of three statuses:
-- absent (counts as zero), medical or exempt (the component is left out of
-- that subject's total). The exam, the section, the subject and the year are
-- copied from the paper through one composite foreign key, so the scope
-- predicates can read them off the row and they can never disagree.
CREATE TABLE exam_marks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    school_id uuid NOT NULL REFERENCES schools (id) ON DELETE RESTRICT,
    paper_id uuid NOT NULL,
    exam_id uuid NOT NULL,
    academic_year_id uuid NOT NULL,
    section_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    student_id uuid NOT NULL,
    component text NOT NULL CHECK (component IN ('periodic_test', 'notebook', 'subject_enrichment', 'written')),
    status text NOT NULL CHECK (status IN ('marked', 'absent', 'medical', 'exempt')),
    marks_tenths integer,
    -- 1 for the first save of a cell, then one more per row that supersedes
    -- it. The unique index makes "the newest row" unambiguous.
    revision integer NOT NULL CHECK (revision > 0),
    supersedes_mark_id uuid,
    -- 'entry' is a save of the marks sheet (the subject teacher, or the
    -- office before the deadline); 'correction' is the office's change with
    -- a reason.
    kind text NOT NULL CHECK (kind IN ('entry', 'correction')),
    -- Why a saved mark changed. The words somebody typed are the audit note;
    -- only the kind of reason is kept here.
    reason_kind text CHECK (reason_kind IN ('recheck', 'entry_error', 'other')),
    recorded_by_membership_id uuid NOT NULL,
    -- The moment the row was written, after the school lock was taken, so a
    -- publication and a mark are ordered by when they really happened.
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (school_id, id),
    UNIQUE (school_id, paper_id, student_id, component, revision),
    CHECK ((revision = 1) = (supersedes_mark_id IS NULL)),
    -- Every change after the first save carries a reason, whoever makes it.
    CHECK (revision = 1 OR reason_kind IS NOT NULL),
    CHECK (kind = 'entry' OR reason_kind IS NOT NULL),
    CHECK ((status = 'marked') = (marks_tenths IS NOT NULL)),
    -- The component's maximum, as the fixed pattern sets it, in tenths.
    CHECK (marks_tenths IS NULL OR (marks_tenths >= 0 AND marks_tenths <= CASE component
        WHEN 'periodic_test' THEN 100
        WHEN 'notebook' THEN 50
        WHEN 'subject_enrichment' THEN 50
        WHEN 'written' THEN 800
    END)),
    FOREIGN KEY (school_id, paper_id, exam_id, academic_year_id, section_id, subject_id) REFERENCES exam_papers (school_id, id, exam_id, academic_year_id, section_id, subject_id),
    FOREIGN KEY (school_id, student_id) REFERENCES students (school_id, id),
    FOREIGN KEY (school_id, supersedes_mark_id) REFERENCES exam_marks (school_id, id),
    FOREIGN KEY (school_id, recorded_by_membership_id) REFERENCES school_memberships (school_id, id)
);

CREATE INDEX exam_marks_paper_idx ON exam_marks (school_id, paper_id, student_id, component, revision DESC);

CREATE INDEX exam_marks_student_idx ON exam_marks (school_id, student_id);

CREATE INDEX exam_marks_exam_section_idx ON exam_marks (school_id, exam_id, section_id);

-- The office publishing one exam's results for one section. Publishing again
-- after a correction is a new row: a parent sees each mark as it stood at the
-- newest publication, and never a mark written after it.
CREATE TABLE exam_publications (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    school_id uuid NOT NULL REFERENCES schools (id) ON DELETE RESTRICT,
    exam_id uuid NOT NULL,
    academic_year_id uuid NOT NULL,
    section_id uuid NOT NULL,
    published_by_membership_id uuid NOT NULL,
    published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (school_id, id),
    FOREIGN KEY (school_id, academic_year_id, exam_id) REFERENCES exams (school_id, academic_year_id, id),
    FOREIGN KEY (school_id, academic_year_id, section_id) REFERENCES sections (school_id, academic_year_id, id),
    FOREIGN KEY (school_id, published_by_membership_id) REFERENCES school_memberships (school_id, id)
);

CREATE INDEX exam_publications_exam_section_idx ON exam_publications (school_id, exam_id, section_id, published_at DESC);

-- The class teacher's part of a report card for one pupil and one term: the
-- four co-scholastic grades and the remarks. Editable, with a version, until
-- the card is published and after; a published card is a frozen copy and is
-- not changed by an edit here until the office publishes it again.
CREATE TABLE report_card_entries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    school_id uuid NOT NULL REFERENCES schools (id) ON DELETE RESTRICT,
    student_id uuid NOT NULL,
    academic_year_id uuid NOT NULL,
    section_id uuid NOT NULL,
    term text NOT NULL CHECK (term IN ('term_1', 'term_2')),
    work_education text CHECK (work_education IN ('A', 'B', 'C')),
    art_education text CHECK (art_education IN ('A', 'B', 'C')),
    health_physical_education text CHECK (health_physical_education IN ('A', 'B', 'C')),
    discipline text CHECK (discipline IN ('A', 'B', 'C')),
    -- Free text about a child. Cleared when the pupil is anonymised, and never
    -- copied into an audit row.
    remarks text CHECK (remarks IS NULL OR length(remarks) <= 1000),
    updated_by_membership_id uuid NOT NULL,
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (school_id, id),
    UNIQUE (school_id, section_id, student_id, term),
    FOREIGN KEY (school_id, student_id) REFERENCES students (school_id, id),
    FOREIGN KEY (school_id, academic_year_id, section_id) REFERENCES sections (school_id, academic_year_id, id),
    FOREIGN KEY (school_id, updated_by_membership_id) REFERENCES school_memberships (school_id, id)
);

-- A published report card, frozen. The content is everything the card shows
-- (the figures, the grade bands, the marks-or-grades choice and the layout at
-- that moment) except the remarks, which are kept apart so that anonymising
-- the pupil can clear them and nothing else. Publishing again is a new
-- version; the earlier one stays.
CREATE TABLE report_card_versions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    school_id uuid NOT NULL REFERENCES schools (id) ON DELETE RESTRICT,
    student_id uuid NOT NULL,
    academic_year_id uuid NOT NULL,
    section_id uuid NOT NULL,
    card text NOT NULL CHECK (card IN ('term_1', 'final')),
    version_number integer NOT NULL CHECK (version_number > 0),
    content jsonb NOT NULL,
    -- {"term_1": "...", "term_2": "..."} as published, or NULL.
    remarks jsonb,
    -- A digest of what was published, so a screen can say "changed since
    -- published" without comparing whole documents.
    content_hash text NOT NULL CHECK (length(content_hash) BETWEEN 16 AND 128),
    published_by_membership_id uuid NOT NULL,
    published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (school_id, id),
    UNIQUE (school_id, student_id, academic_year_id, card, version_number),
    FOREIGN KEY (school_id, student_id) REFERENCES students (school_id, id),
    FOREIGN KEY (school_id, academic_year_id, section_id) REFERENCES sections (school_id, academic_year_id, id),
    FOREIGN KEY (school_id, published_by_membership_id) REFERENCES school_memberships (school_id, id)
);

CREATE INDEX report_card_versions_student_idx ON report_card_versions (school_id, student_id, academic_year_id, card, version_number DESC);

CREATE INDEX report_card_versions_section_idx ON report_card_versions (school_id, section_id, card);

-- The school's own grade bands, the marks-or-grades choice and the report
-- card layout. One row per school; a school with no row uses the defaults in
-- @erp/contracts. The JSON shapes are checked by the API against the same
-- contracts before they are written.
CREATE TABLE exam_settings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    school_id uuid NOT NULL REFERENCES schools (id) ON DELETE RESTRICT,
    display_mode text NOT NULL CHECK (display_mode IN ('marks', 'grades')),
    grade_bands jsonb NOT NULL CHECK (jsonb_typeof(grade_bands) = 'array'),
    layout jsonb NOT NULL CHECK (jsonb_typeof(layout) = 'object'),
    updated_by_membership_id uuid NOT NULL,
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (school_id),
    UNIQUE (school_id, id),
    FOREIGN KEY (school_id, updated_by_membership_id) REFERENCES school_memberships (school_id, id)
);

-- Append-only in the database, not only in the API. The same function as the
-- attendance register refuses every UPDATE and every DELETE of a mark and of
-- a publication.
CREATE FUNCTION exam_events_immutable ()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME;
END
$$;

CREATE TRIGGER exam_marks_no_change
    BEFORE UPDATE OR DELETE ON exam_marks
    FOR EACH ROW
    EXECUTE FUNCTION exam_events_immutable ();

CREATE TRIGGER exam_publications_no_change
    BEFORE UPDATE OR DELETE ON exam_publications
    FOR EACH ROW
    EXECUTE FUNCTION exam_events_immutable ();

-- A published report card is never edited or removed. The one change allowed
-- is the one anonymisation needs: the remarks cleared, with every other
-- column exactly as it was.
CREATE FUNCTION report_card_versions_immutable ()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.remarks IS NULL AND (to_jsonb (NEW) - 'remarks') = (to_jsonb (OLD) - 'remarks') THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'published report cards are append-only';
END
$$;

CREATE TRIGGER report_card_versions_no_change
    BEFORE UPDATE OR DELETE ON report_card_versions
    FOR EACH ROW
    EXECUTE FUNCTION report_card_versions_immutable ();

DO $$
DECLARE
    table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY['exams', 'exam_papers', 'exam_marks', 'exam_publications', 'report_card_entries', 'report_card_versions', 'exam_settings']
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
        EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (school_id = NULLIF(current_setting(''app.school_id'', true), '''')::uuid) WITH CHECK (school_id = NULLIF(current_setting(''app.school_id'', true), '''')::uuid)', table_name);
    END LOOP;
END
$$;

REVOKE ALL ON exams, exam_papers, exam_marks, exam_publications, report_card_entries, report_card_versions, exam_settings FROM PUBLIC;

-- Editable records: read, add and change. Nothing about an exam is removed
-- except a paper that no longer belongs to its class and has no marks (the
-- foreign key from exam_marks refuses the rest).
GRANT SELECT, INSERT, UPDATE ON exams, report_card_entries, exam_settings TO erp_runtime;

GRANT SELECT, INSERT, DELETE ON exam_papers TO erp_runtime;

-- Events: read and append. No UPDATE and no DELETE, for anybody the API runs as.
GRANT SELECT, INSERT ON exam_marks, exam_publications, report_card_versions TO erp_runtime;

-- The one column anonymisation clears, and the trigger above lets it do
-- nothing else with it.
GRANT UPDATE (remarks) ON report_card_versions TO erp_runtime;

-- The school's logo, in the private document store exactly as a photograph
-- is. The key is server state and never leaves the API. logo_url, from an
-- earlier design, stays unused and untouched.
ALTER TABLE schools
    ADD COLUMN logo_storage_key text,
    ADD COLUMN logo_content_type text CHECK (logo_content_type IN ('image/png', 'image/jpeg')),
    ADD COLUMN logo_updated_at timestamptz,
    ADD CONSTRAINT schools_logo_complete CHECK ((logo_storage_key IS NULL) = (logo_content_type IS NULL));

-- Three new kinds of export file: a section's marks register for one paper, one
-- pupil's report card, and a section's report cards as one document.
ALTER TABLE export_jobs
    DROP CONSTRAINT export_jobs_kind_check;

ALTER TABLE export_jobs
    ADD CONSTRAINT export_jobs_kind_check CHECK (kind IN ('students', 'staff', 'audit', 'student_profile', 'staff_profile', 'timetable', 'fee_receipt', 'fee_dues', 'fee_collections', 'attendance_register', 'attendance_pupil_month', 'staff_attendance_register', 'exam_marks_register', 'report_card', 'report_cards_section'));
