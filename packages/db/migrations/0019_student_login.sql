-- Task 23: student login.
--
-- A pupil in Class 9 to 12 signs in with the school's login code, their
-- admission number and a password. The school creates the login when the
-- pupil is admitted or promoted into one of those classes and texts a
-- generated password to the primary guardian's phone; the pupil must choose
-- their own password the first time they sign in. Only the office switches a
-- login off, and it ends when the pupil leaves.
--
-- The pupil's identity is an ordinary auth_user with a generated,
-- non-deliverable address ending in @student.invalid and a credential
-- account. Nobody can sign in with that address directly: the API accepts it
-- only from its own school-code-and-admission-number route. The membership is
-- kind 'student', holds the student role and nothing else, and is linked to
-- the pupil through membership_student_links, which already exists.
--
-- The change is additive apart from the rule that refused an active student
-- membership, which is lifted here. The release before this one keeps
-- running against it: it never creates a student membership and still
-- refuses a student identity a session.

-- Which classes are Class 1 to 12. Nursery, LKG and UKG have no number. A
-- class named "Class 9", "Grade 9", "Std 9", "Standard 9" or "Class IX", with
-- or without a stream after it, gets its number here; the office sets the
-- rest in setup.
ALTER TABLE grades
    ADD COLUMN level smallint CHECK (level BETWEEN 1 AND 12);

UPDATE
    grades
SET
    level = parsed.level
FROM (
    SELECT
        id,
        COALESCE(substring(name FROM '(?i)^\s*(?:class|grade|std\.?|standard)\s*(\d{1,2})(?!\d)')::int, array_position(ARRAY['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x', 'xi', 'xii'], lower(substring(name FROM '(?i)^\s*(?:class|grade|std\.?|standard)\s+(xii|xi|x|ix|viii|vii|vi|v|iv|iii|ii|i)(?![a-z])')))) AS level
    FROM
        grades) AS parsed
WHERE
    parsed.id = grades.id
    AND parsed.level BETWEEN 1 AND 12;

ALTER TABLE grades FORCE ROW LEVEL SECURITY;

-- A generated password is a credential that travelled by text message, so
-- the person must replace it before they can use the school's data.
ALTER TABLE auth_user
    ADD COLUMN must_change_password boolean NOT NULL DEFAULT FALSE;

-- A student membership may now be active. Every other rule stays: a student
-- membership holds the student role only and no staff or guardian link, and
-- an adult membership never holds the student role or a student link.
CREATE OR REPLACE FUNCTION enforce_membership_kind_state ()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM
        1
    FROM
        school_memberships
    WHERE
        school_id = NEW.school_id
        AND id = NEW.id
    FOR UPDATE;
    IF NEW.kind = 'student' AND (EXISTS (
        SELECT
            1
        FROM
            membership_staff_links
        WHERE
            school_id = NEW.school_id AND membership_id = NEW.id) OR EXISTS (
        SELECT
            1
        FROM
            membership_guardian_links
        WHERE
            school_id = NEW.school_id AND membership_id = NEW.id)) THEN
        RAISE EXCEPTION 'student membership has adult link';
    END IF;
    IF NEW.kind = 'adult' AND EXISTS (
        SELECT
            1
        FROM
            membership_student_links
        WHERE
            school_id = NEW.school_id AND membership_id = NEW.id) THEN
        RAISE EXCEPTION 'adult membership has student link';
    END IF;
    IF NEW.kind = 'student' AND EXISTS (
        SELECT
            1
        FROM
            membership_roles mr
            JOIN roles r ON (r.school_id,
            r.id) = (mr.school_id,
        mr.role_id)
WHERE
    mr.school_id = NEW.school_id AND mr.membership_id = NEW.id AND r.key <> 'student') THEN
        RAISE EXCEPTION 'student membership has adult role';
    END IF;
    IF NEW.kind = 'adult' AND EXISTS (
        SELECT
            1
        FROM
            membership_roles mr
            JOIN roles r ON (r.school_id,
            r.id) = (mr.school_id,
        mr.role_id)
WHERE
    mr.school_id = NEW.school_id AND mr.membership_id = NEW.id AND r.key = 'student') THEN
        RAISE EXCEPTION 'adult membership has student role';
    END IF;
    RETURN NEW;
END
$$;

-- The identity bootstrap functions below are owned by erp_identity_reader.
-- The rule from 0011: grant CREATE for the ownership transfer and take it
-- away again at the end of this section.
GRANT CREATE ON SCHEMA public TO erp_identity_reader;

-- Every usable membership of one identity, adult or student. It replaces
-- active_adult_memberships_for_user in this release; that function stays for
-- the release before this one and is dropped later.
CREATE FUNCTION active_memberships_for_user (identity_user_id uuid)
    RETURNS TABLE (
        membership_id uuid,
        school_id uuid,
        kind membership_kind,
        version integer,
        access_version integer)
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog,
    public
    AS $$
    SELECT
        membership.id,
        membership.school_id,
        membership.kind,
        membership.version,
        membership.access_version
    FROM
        public.school_memberships AS membership
        JOIN public.schools AS school ON school.id = membership.school_id
    WHERE
        membership.user_id = identity_user_id
        AND membership.status = 'active'
        AND school.status IN ('active', 'trial')
$$;

ALTER FUNCTION active_memberships_for_user (uuid) OWNER TO erp_identity_reader;

REVOKE ALL ON FUNCTION active_memberships_for_user (uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION active_memberships_for_user (uuid) FROM erp_runtime, erp_auth;

GRANT EXECUTE ON FUNCTION active_memberships_for_user (uuid) TO erp_identity;

-- 'none' for an identity that has never been a pupil, 'active' for a pupil
-- whose login is on in a school that is open, 'inactive' otherwise (switched
-- off, ended, or the school suspended). An inactive student identity never
-- holds a session.
CREATE FUNCTION student_login_state (identity_user_id uuid)
    RETURNS text
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog,
    public
    AS $$
    SELECT
        CASE WHEN NOT EXISTS (
            SELECT
                1
            FROM
                public.school_memberships AS membership
            WHERE
                membership.user_id = identity_user_id
                AND membership.kind = 'student') THEN
            'none'
        WHEN EXISTS (
            SELECT
                1
            FROM
                public.school_memberships AS membership
                JOIN public.schools AS school ON school.id = membership.school_id
            WHERE
                membership.user_id = identity_user_id
                AND membership.kind = 'student'
                AND membership.status = 'active'
                AND school.status IN ('active', 'trial')) THEN
            'active'
        ELSE
            'inactive'
        END
$$;

ALTER FUNCTION student_login_state (uuid) OWNER TO erp_identity_reader;

REVOKE ALL ON FUNCTION student_login_state (uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION student_login_state (uuid) FROM erp_runtime, erp_auth;

GRANT EXECUTE ON FUNCTION student_login_state (uuid) TO erp_identity;

-- The sign-in lookup: the identity behind a school's login code and one of
-- its admission numbers, only while the pupil is on the roll and the login is
-- on. Both inputs are compared without regard to case or surrounding space.
-- Nothing else about the pupil leaves this function.
GRANT SELECT (id, school_id, admission_number, status) ON students TO erp_identity_reader;

GRANT SELECT (school_id, membership_id, student_id) ON membership_student_links TO erp_identity_reader;

GRANT SELECT (login_code) ON schools TO erp_identity_reader;

CREATE POLICY identity_bootstrap ON students
    FOR SELECT TO erp_identity_reader
    USING (CURRENT_USER = 'erp_identity_reader');

CREATE POLICY identity_bootstrap ON membership_student_links
    FOR SELECT TO erp_identity_reader
    USING (CURRENT_USER = 'erp_identity_reader');

CREATE FUNCTION student_sign_in_user (school_login_code text, pupil_admission_number text)
    RETURNS uuid
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog,
    public
    AS $$
    SELECT
        membership.user_id
    FROM
        public.schools AS school
        JOIN public.students AS pupil ON pupil.school_id = school.id
        JOIN public.membership_student_links AS link ON link.school_id = pupil.school_id
            AND link.student_id = pupil.id
        JOIN public.school_memberships AS membership ON membership.school_id = link.school_id
            AND membership.id = link.membership_id
    WHERE
        lower(school.login_code) = lower(btrim(school_login_code))
        AND school.status IN ('active', 'trial')
        AND upper(pupil.admission_number) = upper(btrim(pupil_admission_number))
        AND pupil.status = 'active'
        AND membership.kind = 'student'
        AND membership.status = 'active'
    LIMIT 1
$$;

ALTER FUNCTION student_sign_in_user (text, text) OWNER TO erp_identity_reader;

REVOKE ALL ON FUNCTION student_sign_in_user (text, text) FROM PUBLIC;

REVOKE ALL ON FUNCTION student_sign_in_user (text, text) FROM erp_runtime, erp_auth;

GRANT EXECUTE ON FUNCTION student_sign_in_user (text, text) TO erp_identity;

REVOKE CREATE ON SCHEMA public FROM erp_identity_reader;

-- A test build holds the student password text like the other codes.
ALTER TABLE held_sms
    DROP CONSTRAINT held_sms_purpose_check;

ALTER TABLE held_sms
    ADD CONSTRAINT held_sms_purpose_check CHECK (purpose IN ('otp', 'password_reset', 'verification', 'invitation', 'student_password'));

-- Messages to pupils.
--
-- A notice to families can also, or instead, go to the pupils themselves:
-- recipients says which ('families', 'students' or 'both'). It is null for
-- the staff audiences, which have neither. A pupil receives it in the app
-- only, through their own login; there is no email to a pupil. The automatic
-- messages about attendance, results, report cards and fees go to families
-- only; a pupil's birthday wish goes to the pupil as well.
--
-- A new audience, 'grade_range', is every class from grade_id to grade_to_id
-- in the school's class order, both ends included ("Class 6 to Class 8").
ALTER TABLE messages
    ADD COLUMN recipients text CHECK (recipients IN ('families', 'students', 'both')),
    ADD COLUMN grade_to_id uuid,
    ADD FOREIGN KEY (school_id, grade_to_id) REFERENCES grades (school_id, id);

-- Every message written so far went to families.
ALTER TABLE messages NO FORCE ROW LEVEL SECURITY;

UPDATE
    messages
SET
    recipients = 'families'
WHERE
    audience NOT IN ('staff', 'staff_member');

ALTER TABLE messages FORCE ROW LEVEL SECURITY;

ALTER TABLE messages
    ADD CONSTRAINT messages_recipients_audience_check CHECK ((audience IN ('staff', 'staff_member')) = (recipients IS NULL)),
    ADD CONSTRAINT messages_automatic_recipients_check CHECK (kind IN ('notice', 'birthday_pupil', 'birthday_staff') OR recipients = 'families');

ALTER TABLE messages
    DROP CONSTRAINT messages_audience_check;

ALTER TABLE messages
    ADD CONSTRAINT messages_audience_check CHECK (audience IN ('school', 'staff', 'grade', 'grade_range', 'section', 'pupil', 'staff_member'));

ALTER TABLE messages
    DROP CONSTRAINT messages_check6;

ALTER TABLE messages
    ADD CONSTRAINT messages_audience_shape_check CHECK ((audience IN ('school', 'staff') AND grade_id IS NULL AND grade_to_id IS NULL AND section_id IS NULL AND student_id IS NULL AND staff_id IS NULL)
        OR (audience = 'grade' AND grade_id IS NOT NULL AND grade_to_id IS NULL AND section_id IS NULL AND student_id IS NULL AND staff_id IS NULL)
        OR (audience = 'grade_range' AND grade_id IS NOT NULL AND grade_to_id IS NOT NULL AND section_id IS NULL AND student_id IS NULL AND staff_id IS NULL)
        OR (audience = 'section' AND grade_id IS NULL AND grade_to_id IS NULL AND section_id IS NOT NULL AND student_id IS NULL AND staff_id IS NULL)
        OR (audience = 'pupil' AND grade_id IS NULL AND grade_to_id IS NULL AND student_id IS NOT NULL AND staff_id IS NULL)
        OR (audience = 'staff_member' AND grade_id IS NULL AND grade_to_id IS NULL AND section_id IS NULL AND student_id IS NULL AND staff_id IS NOT NULL));

-- The two new columns are part of the record of what was said to whom.
CREATE OR REPLACE FUNCTION messages_guard ()
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
            OR NEW.recipients IS DISTINCT FROM OLD.recipients
            OR NEW.grade_id IS DISTINCT FROM OLD.grade_id
            OR NEW.grade_to_id IS DISTINCT FROM OLD.grade_to_id
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

-- A recipient row is now a guardian, a staff member or a pupil. A pupil's
-- row names the pupil in student_id, shows in the app through the pupil's own
-- membership when they have a login, and never has an email.
ALTER TABLE message_recipients
    ADD COLUMN is_student boolean NOT NULL DEFAULT FALSE;

ALTER TABLE message_recipients
    DROP CONSTRAINT message_recipients_check;

ALTER TABLE message_recipients
    ADD CONSTRAINT message_recipients_person_check CHECK ((guardian_id IS NOT NULL)::int + (staff_id IS NOT NULL)::int + is_student::int = 1),
    ADD CONSTRAINT message_recipients_student_check CHECK (NOT is_student OR (student_id IS NOT NULL AND email_status = 'none'));

CREATE UNIQUE INDEX message_recipients_student_uidx ON message_recipients (school_id, message_id, student_id)
WHERE
    is_student;
