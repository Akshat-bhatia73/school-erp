-- Admin feedback: government student numbers, staff Aadhaar and leave.
--
-- The office asked for three things that need storage:
--
--  * a pupil's PEN (the Permanent Education Number UDISE+ gives every child)
--    and the state's student registration number (SRN), typed at admission
--    next to the APAAR id. Neither is sealed: both are printed on transfer
--    certificates and state portals and carry nothing an attacker could use,
--    unlike the APAAR id and the Aadhaar number, which stay sealed;
--  * a staff member's Aadhaar number, sealed exactly like the student's, with
--    the last four digits a screen may show;
--  * leave recorded ahead of time for a pupil or a staff member, a date range
--    with a reason. It is a plan, not a mark: the register pre-fills "leave"
--    for the days it covers, and an unmarked school day inside it counts as
--    leave instead of against the person. A mark somebody saved always wins.
--
-- The change is additive: new nullable columns and one new table. The release
-- before this one keeps running against it and never reads them.
ALTER TABLE students
    ADD COLUMN pen text,
    ADD COLUMN srn text;

ALTER TABLE students
    ADD CONSTRAINT students_pen_check CHECK (pen IS NULL OR pen ~ '^[0-9]{11}$'),
    ADD CONSTRAINT students_srn_check CHECK (srn IS NULL OR (length(srn) BETWEEN 1 AND 30 AND srn ~ '^[A-Za-z0-9/-]+$'));

ALTER TABLE staff
    ADD COLUMN aadhaar_ciphertext text,
    ADD COLUMN aadhaar_last4 text;

ALTER TABLE staff
    ADD CONSTRAINT staff_aadhaar_last4_check CHECK (aadhaar_last4 IS NULL OR aadhaar_last4 ~ '^[0-9]{4}$'),
    ADD CONSTRAINT staff_aadhaar_complete_check CHECK ((aadhaar_ciphertext IS NULL) = (aadhaar_last4 IS NULL));

-- One row per stretch of leave for one person. Exactly one of student_id and
-- staff_id is set, and person_kind says which, so a query can never mix the
-- two. A row is never removed: cancelling it stamps cancelled_at and the
-- member who did it, and the audit row carries the reason. The API refuses a
-- second active row that overlaps the dates of another for the same person,
-- under the school lock.
CREATE TABLE leave_records (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    school_id uuid NOT NULL REFERENCES schools (id) ON DELETE RESTRICT,
    person_kind text NOT NULL CHECK (person_kind IN ('student', 'staff')),
    student_id uuid,
    staff_id uuid,
    starts_on date NOT NULL,
    ends_on date NOT NULL,
    reason text CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 500),
    recorded_by_membership_id uuid NOT NULL,
    cancelled_at timestamptz,
    cancelled_by_membership_id uuid,
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (school_id, id),
    CHECK ((person_kind = 'student') = (student_id IS NOT NULL)),
    CHECK ((person_kind = 'staff') = (staff_id IS NOT NULL)),
    CHECK (ends_on >= starts_on),
    CHECK (ends_on - starts_on < 366),
    CHECK ((cancelled_at IS NULL) = (cancelled_by_membership_id IS NULL)),
    FOREIGN KEY (school_id, student_id) REFERENCES students (school_id, id),
    FOREIGN KEY (school_id, staff_id) REFERENCES staff (school_id, id),
    FOREIGN KEY (school_id, recorded_by_membership_id) REFERENCES school_memberships (school_id, id),
    FOREIGN KEY (school_id, cancelled_by_membership_id) REFERENCES school_memberships (school_id, id)
);

CREATE INDEX leave_records_student_idx ON leave_records (school_id, student_id, starts_on) WHERE student_id IS NOT NULL;

CREATE INDEX leave_records_staff_idx ON leave_records (school_id, staff_id, starts_on) WHERE staff_id IS NOT NULL;

CREATE INDEX leave_records_dates_idx ON leave_records (school_id, starts_on, ends_on);

ALTER TABLE leave_records ENABLE ROW LEVEL SECURITY;

ALTER TABLE leave_records FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON leave_records
    USING (school_id = NULLIF(current_setting('app.school_id', true), '')::uuid)
    WITH CHECK (school_id = NULLIF(current_setting('app.school_id', true), '')::uuid);

REVOKE ALL ON leave_records FROM PUBLIC;

-- Record and cancel. No DELETE for anybody the API runs as.
GRANT SELECT, INSERT, UPDATE ON leave_records TO erp_runtime;
