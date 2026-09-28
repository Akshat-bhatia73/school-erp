-- Leave applications: a parent asks for leave for their child, a staff member
-- for themselves, and somebody decides.
--
-- The rules, decided with the school on 28 September 2026:
--  * a pupil's application is decided by the class teacher of the pupil's
--    section or by the office, whoever acts first;
--  * a staff member's application is decided by the office (owner, principal,
--    administrator);
--  * a staff application carries a type (sick, casual, other) and no yearly
--    balance; a pupil's application carries none;
--  * an application may start up to seven days before the day it is made.
--
-- Approving an application writes the leave record (0028) in the same
-- transaction and links it here, so everything downstream (the register
-- pre-fill, the figures, the dashboard) works from leave_records alone. An
-- application is never removed: it is pending, then approved, refused or
-- withdrawn by the person who applied, and stays as the history.
--
-- The change is additive: one new table, one new settings column and three
-- CHECK constraints widened for the decision message. The release before this
-- one keeps running against it and never sends that kind.
CREATE TABLE leave_applications (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    school_id uuid NOT NULL REFERENCES schools (id) ON DELETE RESTRICT,
    person_kind text NOT NULL CHECK (person_kind IN ('student', 'staff')),
    student_id uuid,
    staff_id uuid,
    leave_type text CHECK (leave_type IN ('sick', 'casual', 'other')),
    starts_on date NOT NULL,
    ends_on date NOT NULL,
    reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'refused', 'withdrawn')),
    applied_by_membership_id uuid NOT NULL,
    decided_by_membership_id uuid,
    decided_at timestamptz,
    -- What the decider wrote back: required on a refusal, optional on an
    -- approval. The applicant reads it.
    decision_note text CHECK (decision_note IS NULL OR length(decision_note) BETWEEN 1 AND 500),
    leave_record_id uuid,
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (school_id, id),
    UNIQUE (school_id, leave_record_id),
    CHECK ((person_kind = 'student') = (student_id IS NOT NULL)),
    CHECK ((person_kind = 'staff') = (staff_id IS NOT NULL)),
    CHECK ((person_kind = 'staff') = (leave_type IS NOT NULL)),
    CHECK (ends_on >= starts_on),
    CHECK (ends_on - starts_on < 366),
    CHECK ((status IN ('approved', 'refused')) = (decided_by_membership_id IS NOT NULL)),
    CHECK ((status IN ('approved', 'refused', 'withdrawn')) = (decided_at IS NOT NULL)),
    CHECK ((status = 'approved') = (leave_record_id IS NOT NULL)),
    CHECK (status <> 'refused' OR decision_note IS NOT NULL),
    FOREIGN KEY (school_id, student_id) REFERENCES students (school_id, id),
    FOREIGN KEY (school_id, staff_id) REFERENCES staff (school_id, id),
    FOREIGN KEY (school_id, applied_by_membership_id) REFERENCES school_memberships (school_id, id),
    FOREIGN KEY (school_id, decided_by_membership_id) REFERENCES school_memberships (school_id, id),
    FOREIGN KEY (school_id, leave_record_id) REFERENCES leave_records (school_id, id)
);

CREATE INDEX leave_applications_status_idx ON leave_applications (school_id, status, starts_on);

CREATE INDEX leave_applications_student_idx ON leave_applications (school_id, student_id) WHERE student_id IS NOT NULL;

CREATE INDEX leave_applications_staff_idx ON leave_applications (school_id, staff_id) WHERE staff_id IS NOT NULL;

ALTER TABLE leave_applications ENABLE ROW LEVEL SECURITY;

ALTER TABLE leave_applications FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON leave_applications
    USING (school_id = NULLIF(current_setting('app.school_id', true), '')::uuid)
    WITH CHECK (school_id = NULLIF(current_setting('app.school_id', true), '')::uuid);

REVOKE ALL ON leave_applications FROM PUBLIC;

-- Apply, decide and withdraw. No DELETE for anybody the API runs as.
GRANT SELECT, INSERT, UPDATE ON leave_applications TO erp_runtime;

-- The decision goes back to whoever applied as an automatic message: to the
-- pupil's family (audience 'pupil', like an absence notice) or to the staff
-- member (audience 'staff_member', like the staff birthday wish).
ALTER TABLE communication_settings
    ADD COLUMN leave_decisions_enabled boolean NOT NULL DEFAULT TRUE;

ALTER TABLE message_templates
    DROP CONSTRAINT message_templates_kind_check;

ALTER TABLE message_templates
    ADD CONSTRAINT message_templates_kind_check CHECK (kind IN ('notice', 'absence', 'result', 'report_card', 'fee_reminder', 'fee_overdue', 'birthday_pupil', 'birthday_staff', 'leave_decision_pupil', 'leave_decision_staff'));

ALTER TABLE messages
    DROP CONSTRAINT messages_kind_check;

ALTER TABLE messages
    ADD CONSTRAINT messages_kind_check CHECK (kind IN ('notice', 'absence', 'result', 'report_card', 'fee_reminder', 'fee_overdue', 'birthday_pupil', 'birthday_staff', 'leave_decision_pupil', 'leave_decision_staff'));

-- The two unnamed audience rules of 0018 are found by what they say rather
-- than by the name PostgreSQL gave them, then written again with the staff
-- decision next to the staff birthday wish.
DO $$
DECLARE
    found record;
BEGIN
    FOR found IN
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'messages'::regclass
            AND contype = 'c'
            AND pg_get_constraintdef(oid) LIKE '%birthday_staff%'
            AND pg_get_constraintdef(oid) LIKE '%audience%'
    LOOP
        EXECUTE format('ALTER TABLE messages DROP CONSTRAINT %I', found.conname);
    END LOOP;
END
$$;

ALTER TABLE messages
    ADD CONSTRAINT messages_audience_by_kind_check CHECK (kind = 'notice' OR (kind IN ('birthday_staff', 'leave_decision_staff') AND audience = 'staff_member') OR (kind NOT IN ('birthday_staff', 'leave_decision_staff') AND audience = 'pupil')),
    ADD CONSTRAINT messages_staff_member_kind_check CHECK (audience <> 'staff_member' OR kind IN ('birthday_staff', 'leave_decision_staff'));

-- The staff decision, like the staff birthday wish, names no family.
ALTER TABLE messages
    DROP CONSTRAINT messages_automatic_recipients_check;

ALTER TABLE messages
    ADD CONSTRAINT messages_automatic_recipients_check CHECK (kind IN ('notice', 'birthday_pupil', 'birthday_staff', 'leave_decision_staff') OR recipients = 'families');
