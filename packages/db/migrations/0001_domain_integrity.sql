-- Task 1 corrections: fixed domain values are columns. JSON remains only for
-- genuinely flexible metadata and safe audit/outbox payloads.
ALTER TABLE auth_two_factor
    ADD COLUMN verified boolean NOT NULL DEFAULT TRUE,
    ADD COLUMN failed_verification_count integer NOT NULL DEFAULT 0,
    ADD COLUMN locked_until timestamptz;

ALTER TABLE schools
    ADD COLUMN board text,
    ADD COLUMN affiliation_number text,
    ADD COLUMN udise_code text,
    ADD COLUMN address jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN phone text,
    ADD COLUMN email text,
    ADD COLUMN website text,
    ADD COLUMN principal_name text,
    ADD COLUMN established_year integer,
    ADD COLUMN logo_url text,
    ADD COLUMN access_version integer NOT NULL DEFAULT 1 CHECK (access_version > 0),
    ADD COLUMN current_academic_year_id uuid;

ALTER TABLE schools
    ADD CONSTRAINT schools_current_year_fk FOREIGN KEY (id, current_academic_year_id) REFERENCES academic_years (school_id, id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE staff
    ADD COLUMN gender text,
    ADD COLUMN date_of_birth date,
    ADD COLUMN blood_group text,
    ADD COLUMN phone text,
    ADD COLUMN email text,
    ADD COLUMN photo_url text,
    ADD COLUMN address jsonb,
    ADD COLUMN department text,
    ADD COLUMN employment_type text,
    ADD COLUMN joining_date date,
    ADD COLUMN leaving_date date,
    ADD COLUMN qualification text,
    ADD COLUMN experience_years numeric,
    ADD COLUMN monthly_salary numeric,
    ADD COLUMN bank_account_last4 text,
    ADD COLUMN pan_last4 text,
    ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);

ALTER TABLE students
    ADD COLUMN date_of_birth date,
    ADD COLUMN gender text,
    ADD COLUMN blood_group text,
    ADD COLUMN category text,
    ADD COLUMN religion text,
    ADD COLUMN mother_tongue text,
    ADD COLUMN nationality text,
    ADD COLUMN aadhaar_last4 text,
    ADD COLUMN apaar_id text,
    ADD COLUMN photo_url text,
    ADD COLUMN address jsonb,
    ADD COLUMN admission_date date,
    ADD COLUMN admission_type text,
    ADD COLUMN previous_school text,
    ADD COLUMN left_on date,
    ADD COLUMN left_reason text,
    ADD COLUMN house text,
    ADD COLUMN medical_notes text,
    ADD COLUMN uses_transport boolean NOT NULL DEFAULT FALSE;

ALTER TABLE guardians
    ADD COLUMN phone text,
    ADD COLUMN alt_phone text,
    ADD COLUMN email text,
    ADD COLUMN occupation text,
    ADD COLUMN qualification text,
    ADD COLUMN annual_income numeric,
    ADD COLUMN address jsonb,
    ADD COLUMN photo_url text,
    ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);

ALTER TABLE staff
    DROP COLUMN private_data,
    DROP COLUMN pay_data;

ALTER TABLE students
    DROP COLUMN basic_data,
    DROP COLUMN sensitive_data,
    DROP COLUMN medical_data;

ALTER TABLE guardians
    DROP COLUMN contact_data,
    DROP COLUMN private_data;

-- A section always belongs to its stated academic year. Each reference that
-- supplies both values therefore uses the composite key, not school alone.
ALTER TABLE sections
    ADD CONSTRAINT sections_school_year_id_unique UNIQUE (school_id, academic_year_id, id);

ALTER TABLE sections
    ADD COLUMN room_number text,
    ADD COLUMN capacity integer CHECK (capacity IS NULL
        OR capacity > 0),
        ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);

ALTER TABLE academic_years
    ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);

ALTER TABLE grades
    ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);

ALTER TABLE subjects
    ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);

ALTER TABLE enrollments
    DROP CONSTRAINT enrollments_school_id_section_id_fkey;

ALTER TABLE enrollments
    ADD CONSTRAINT enrollments_school_year_section_fk FOREIGN KEY (school_id, academic_year_id, section_id) REFERENCES sections (school_id, academic_year_id, id);

ALTER TABLE teaching_assignments
    DROP CONSTRAINT teaching_assignments_school_id_section_id_fkey;

ALTER TABLE teaching_assignments
    ADD CONSTRAINT teaching_assignments_school_year_section_fk FOREIGN KEY (school_id, academic_year_id, section_id) REFERENCES sections (school_id, academic_year_id, id);

ALTER TABLE timetable_entries
    DROP CONSTRAINT timetable_entries_school_id_section_id_fkey;

ALTER TABLE timetable_entries
    ADD CONSTRAINT timetable_entries_school_year_section_fk FOREIGN KEY (school_id, academic_year_id, section_id) REFERENCES sections (school_id, academic_year_id, id);

ALTER TABLE resource_access_rules
    ADD COLUMN academic_year_id uuid;

ALTER TABLE resource_access_rules
    DROP CONSTRAINT resource_access_rules_check1;

ALTER TABLE resource_access_rules
    ADD CONSTRAINT resource_access_rule_one_target CHECK ((target_type = 'school' AND academic_year_id IS NULL AND section_id IS NULL AND student_id IS NULL AND staff_id IS NULL AND document_id IS NULL) OR (target_type = 'section' AND academic_year_id IS NOT NULL AND section_id IS NOT NULL AND student_id IS NULL AND staff_id IS NULL AND document_id IS NULL) OR (target_type = 'student' AND academic_year_id IS NULL AND section_id IS NULL AND student_id IS NOT NULL AND staff_id IS NULL AND document_id IS NULL) OR (target_type = 'staff' AND academic_year_id IS NULL AND section_id IS NULL AND student_id IS NULL AND staff_id IS NOT NULL AND document_id IS NULL) OR (target_type = 'document' AND academic_year_id IS NULL AND section_id IS NULL AND student_id IS NULL AND staff_id IS NULL AND document_id IS NOT NULL));

ALTER TABLE resource_access_rules
    ADD CONSTRAINT resource_rule_school_year_section_fk FOREIGN KEY (school_id, academic_year_id, section_id) REFERENCES sections (school_id, academic_year_id, id);

CREATE TABLE bell_schedule_grades (
    school_id uuid NOT NULL,
    bell_schedule_id uuid NOT NULL,
    grade_id uuid NOT NULL,
    PRIMARY KEY (school_id, bell_schedule_id, grade_id),
    FOREIGN KEY (school_id, bell_schedule_id) REFERENCES bell_schedules (school_id, id) ON DELETE CASCADE,
    FOREIGN KEY (school_id, grade_id) REFERENCES grades (school_id, id) ON DELETE RESTRICT
);

ALTER TABLE bell_schedules
    ADD CONSTRAINT bell_schedule_no_grade_ids CHECK (cardinality(grade_ids) = 0);

ALTER TABLE bell_schedule_grades ENABLE ROW LEVEL SECURITY;

ALTER TABLE bell_schedule_grades FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON bell_schedule_grades
    USING (school_id = NULLIF (current_setting('app.school_id', TRUE), '')::uuid)
    WITH CHECK (school_id = NULLIF (current_setting('app.school_id', TRUE), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON bell_schedule_grades TO erp_runtime;

CREATE FUNCTION enforce_membership_kind_state ()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.kind = 'student' AND NEW.status = 'active' THEN
        RAISE EXCEPTION 'student memberships remain disabled';
    END IF;
    IF NEW.kind = 'student' AND EXISTS (
        SELECT
            1
        FROM
            membership_roles mr
            JOIN roles r ON r.school_id = mr.school_id AND r.id = mr.role_id
        WHERE
            mr.school_id = NEW.school_id AND mr.membership_id = NEW.id AND r.key <> 'student') THEN
        RAISE EXCEPTION 'student membership has adult role';
    END IF;
    IF NEW.kind = 'adult' AND EXISTS (
        SELECT
            1
        FROM
            membership_roles mr
            JOIN roles r ON r.school_id = mr.school_id AND r.id = mr.role_id
        WHERE
            mr.school_id = NEW.school_id AND mr.membership_id = NEW.id AND r.key = 'student') THEN
        RAISE EXCEPTION 'adult membership has student role';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER membership_kind_state
    BEFORE INSERT OR UPDATE OF kind,
    status ON school_memberships
    FOR EACH ROW
    EXECUTE FUNCTION enforce_membership_kind_state ();

CREATE FUNCTION enforce_role_membership_kind ()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    k membership_kind;
    rk text;
BEGIN
    SELECT
        kind
    INTO
        k
    FROM
        school_memberships
    WHERE
        school_id = NEW.school_id
        AND id = NEW.membership_id;
    SELECT
        key
    INTO
        rk
    FROM
        roles
    WHERE
        school_id = NEW.school_id
        AND id = NEW.role_id;
    IF (k = 'student' AND rk <> 'student') OR (k = 'adult' AND rk = 'student') THEN
        RAISE EXCEPTION 'membership role kind mismatch';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER membership_role_kind
    BEFORE INSERT OR UPDATE ON membership_roles
    FOR EACH ROW
    EXECUTE FUNCTION enforce_role_membership_kind ();

-- The catalogue tables are migration/operator-owned. Keep the runtime unable
-- to insert, update, delete or read role grants directly.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE
    ON roles,
    role_permissions FROM erp_runtime;

GRANT SELECT ON roles, role_permissions TO erp_runtime;
