-- Task 1: PostgreSQL tenant boundary. This file is append-only; migration runner
-- stores its SHA-256 checksum and refuses modified applied migrations.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE membership_status AS ENUM (
    'active',
    'suspended',
    'removed'
);

CREATE TYPE membership_kind AS ENUM (
    'adult',
    'student'
);

CREATE TYPE invitation_status AS ENUM (
    'pending',
    'accepted',
    'revoked',
    'expired'
);

CREATE TYPE access_effect AS ENUM (
    'allow',
    'deny'
);

CREATE TYPE delivery_status AS ENUM (
    'queued',
    'processing',
    'sent',
    'failed',
    'dead_letter'
);

CREATE TABLE auth_user (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    name text NOT NULL,
    email text NOT NULL UNIQUE,
    email_verified boolean NOT NULL DEFAULT FALSE,
    image text,
    phone_number text UNIQUE,
    phone_number_verified boolean NOT NULL DEFAULT FALSE,
    two_factor_enabled boolean NOT NULL DEFAULT FALSE,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth_session (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    token text NOT NULL UNIQUE,
    user_id uuid NOT NULL REFERENCES auth_user (id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    ip_address text,
    user_agent text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX auth_session_user_idx ON auth_session (user_id);

CREATE TABLE auth_account (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    account_id text NOT NULL,
    provider_id text NOT NULL,
    user_id uuid NOT NULL REFERENCES auth_user (id) ON DELETE CASCADE,
    access_token text,
    refresh_token text,
    id_token text,
    password text,
    access_token_expires_at timestamptz,
    refresh_token_expires_at timestamptz,
    scope text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider_id, account_id)
);

CREATE TABLE auth_verification (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    identifier text NOT NULL,
    value text NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX auth_verification_identifier_idx ON auth_verification (identifier);

CREATE TABLE auth_two_factor (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    user_id uuid NOT NULL UNIQUE REFERENCES auth_user (id) ON DELETE CASCADE,
    secret text NOT NULL,
    backup_codes text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE schools (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    login_code text NOT NULL UNIQUE,
    name text NOT NULL,
    short_name text NOT NULL,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'trial', 'suspended')),
    timezone text NOT NULL DEFAULT 'Asia/Kolkata',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE school_memberships (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    school_id uuid NOT NULL REFERENCES schools (id) ON DELETE RESTRICT,
    user_id uuid NOT NULL REFERENCES auth_user (id) ON DELETE RESTRICT,
    kind membership_kind NOT NULL,
    status membership_status NOT NULL DEFAULT 'active',
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    access_version integer NOT NULL DEFAULT 1 CHECK (access_version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (school_id, user_id),
    UNIQUE (school_id, id)
);

CREATE INDEX school_memberships_school_user_idx ON school_memberships (school_id, user_id);

CREATE TABLE roles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    school_id uuid NOT NULL REFERENCES schools (id) ON DELETE CASCADE,
    key text NOT NULL,
    name text NOT NULL,
    is_system boolean NOT NULL DEFAULT FALSE,
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (school_id, key),
    UNIQUE (school_id, id)
);

CREATE TABLE role_permissions (
    school_id uuid NOT NULL,
    role_id uuid NOT NULL,
    permission text NOT NULL,
    scope text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (school_id, role_id, permission, scope),
    FOREIGN KEY (school_id, role_id) REFERENCES roles (school_id, id) ON DELETE CASCADE
);

CREATE TABLE membership_roles (
    school_id uuid NOT NULL,
    membership_id uuid NOT NULL,
    role_id uuid NOT NULL,
    assigned_by_membership_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (school_id, membership_id, role_id),
    FOREIGN KEY (school_id, membership_id) REFERENCES school_memberships (school_id, id) ON DELETE CASCADE,
    FOREIGN KEY (school_id, role_id) REFERENCES roles (school_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (school_id, assigned_by_membership_id) REFERENCES school_memberships (school_id, id) ON DELETE RESTRICT
);

CREATE TABLE academic_years (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    school_id uuid NOT NULL REFERENCES schools (id) ON DELETE CASCADE,
    name text NOT NULL,
    start_date date NOT NULL,
    end_date date NOT NULL,
    status text NOT NULL CHECK (status IN ('upcoming', 'current', 'closed')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (start_date < end_date),
    UNIQUE (school_id, id),
    UNIQUE (school_id, name)
);

CREATE TABLE grades (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    school_id uuid NOT NULL REFERENCES schools (id) ON DELETE CASCADE,
    name text NOT NULL,
    short_name text NOT NULL,
    sort_order integer NOT NULL,
    stream text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (school_id, id),
    UNIQUE (school_id, name)
);

CREATE TABLE staff (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    school_id uuid NOT NULL REFERENCES schools (id) ON DELETE CASCADE,
    employee_code text NOT NULL,
    first_name text NOT NULL,
    last_name text,
    staff_type text NOT NULL CHECK (staff_type IN ('teaching', 'non_teaching', 'admin', 'support')),
    designation text NOT NULL,
    status text NOT NULL CHECK (status IN ('active', 'on_leave', 'resigned', 'retired')),
    private_data jsonb NOT NULL DEFAULT '{}'::jsonb,
    pay_data jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (school_id, id),
    UNIQUE (school_id, employee_code)
);

CREATE TABLE sections (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    school_id uuid NOT NULL REFERENCES schools (id) ON DELETE CASCADE,
    grade_id uuid NOT NULL,
    academic_year_id uuid NOT NULL,
    name text NOT NULL,
    class_teacher_staff_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (school_id, id),
    UNIQUE (school_id, academic_year_id, grade_id, name),
    FOREIGN KEY (school_id, grade_id) REFERENCES grades (school_id, id),
    FOREIGN KEY (school_id, academic_year_id) REFERENCES academic_years (school_id, id),
    FOREIGN KEY (school_id, class_teacher_staff_id) REFERENCES staff (school_id, id)
);

CREATE TABLE subjects (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    school_id uuid NOT NULL REFERENCES schools (id) ON DELETE CASCADE,
    name text NOT NULL,
    code text NOT NULL,
    type text NOT NULL CHECK (type IN ('scholastic', 'co_scholastic', 'language', 'elective')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (school_id, id),
    UNIQUE (school_id, code)
);

CREATE TABLE grade_subjects (
    school_id uuid NOT NULL,
    grade_id uuid NOT NULL,
    academic_year_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    is_optional boolean NOT NULL DEFAULT FALSE,
    PRIMARY KEY (school_id, grade_id, academic_year_id, subject_id),
    FOREIGN KEY (school_id, grade_id) REFERENCES grades (school_id, id),
    FOREIGN KEY (school_id, academic_year_id) REFERENCES academic_years (school_id, id),
    FOREIGN KEY (school_id, subject_id) REFERENCES subjects (school_id, id)
);

CREATE TABLE holidays (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    school_id uuid NOT NULL REFERENCES schools (id) ON DELETE CASCADE,
    academic_year_id uuid NOT NULL,
    name text NOT NULL,
    start_date date NOT NULL,
    end_date date NOT NULL,
    type text NOT NULL CHECK (type IN ('national', 'festival', 'school', 'vacation')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (start_date <= end_date),
    UNIQUE (school_id, id),
    FOREIGN KEY (school_id, academic_year_id) REFERENCES academic_years (school_id, id)
);

CREATE TABLE students (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    school_id uuid NOT NULL REFERENCES schools (id) ON DELETE CASCADE,
    admission_number text NOT NULL,
    first_name text NOT NULL,
    last_name text,
    status text NOT NULL CHECK (status IN ('active', 'left', 'alumni', 'suspended')),
    basic_data jsonb NOT NULL DEFAULT '{}'::jsonb,
    sensitive_data jsonb NOT NULL DEFAULT '{}'::jsonb,
    medical_data jsonb NOT NULL DEFAULT '{}'::jsonb,
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (school_id, id),
    UNIQUE (school_id, admission_number)
);

CREATE INDEX students_school_status_idx ON students (school_id, status);

CREATE TABLE guardians (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    school_id uuid NOT NULL REFERENCES schools (id) ON DELETE CASCADE,
    first_name text NOT NULL,
    last_name text,
    contact_data jsonb NOT NULL DEFAULT '{}'::jsonb,
    private_data jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (school_id, id)
);

CREATE TABLE enrollments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    school_id uuid NOT NULL REFERENCES schools (id) ON DELETE CASCADE,
    student_id uuid NOT NULL,
    academic_year_id uuid NOT NULL,
    section_id uuid NOT NULL,
    roll_number integer,
    joined_on date NOT NULL,
    left_on date,
    outcome text NOT NULL DEFAULT 'ongoing' CHECK (outcome IN ('ongoing', 'promoted', 'detained', 'left')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (left_on IS NULL OR joined_on <= left_on),
    UNIQUE (school_id, id),
    FOREIGN KEY (school_id, student_id) REFERENCES students (school_id, id),
    FOREIGN KEY (school_id, academic_year_id) REFERENCES academic_years (school_id, id),
    FOREIGN KEY (school_id, section_id) REFERENCES sections (school_id, id)
);

CREATE INDEX enrollments_school_student_idx ON enrollments (school_id, student_id);

CREATE INDEX enrollments_school_section_idx ON enrollments (school_id, section_id);

CREATE TABLE student_guardians (
    school_id uuid NOT NULL,
    student_id uuid NOT NULL,
    guardian_id uuid NOT NULL,
    relation text NOT NULL CHECK (relation IN ('father', 'mother', 'guardian', 'grandparent', 'sibling', 'other')),
    is_primary boolean NOT NULL DEFAULT FALSE,
    receives_notifications boolean NOT NULL DEFAULT TRUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (school_id, student_id, guardian_id),
    FOREIGN KEY (school_id, student_id) REFERENCES students (school_id, id),
    FOREIGN KEY (school_id, guardian_id) REFERENCES guardians (school_id, id)
);

CREATE TABLE student_documents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    school_id uuid NOT NULL REFERENCES schools (id) ON DELETE CASCADE,
    student_id uuid NOT NULL,
    document_type text NOT NULL,
    file_name text NOT NULL,
    storage_key text NOT NULL,
    size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
    uploaded_by_membership_id uuid,
    verified boolean NOT NULL DEFAULT FALSE,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (school_id, id),
    FOREIGN KEY (school_id, student_id) REFERENCES students (school_id, id),
    FOREIGN KEY (school_id, uploaded_by_membership_id) REFERENCES school_memberships (school_id, id)
);

CREATE TABLE teaching_assignments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    school_id uuid NOT NULL REFERENCES schools (id) ON DELETE CASCADE,
    staff_id uuid NOT NULL,
    academic_year_id uuid NOT NULL,
    section_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    effective_from date NOT NULL,
    effective_to date,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (effective_to IS NULL OR effective_from <= effective_to),
    FOREIGN KEY (school_id, staff_id) REFERENCES staff (school_id, id),
    FOREIGN KEY (school_id, academic_year_id) REFERENCES academic_years (school_id, id),
    FOREIGN KEY (school_id, section_id) REFERENCES sections (school_id, id),
    FOREIGN KEY (school_id, subject_id) REFERENCES subjects (school_id, id)
);

CREATE INDEX teaching_assignments_scope_idx ON teaching_assignments (school_id, staff_id, academic_year_id, section_id, subject_id);

CREATE TABLE bell_schedules (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    school_id uuid NOT NULL REFERENCES schools (id) ON DELETE CASCADE,
    academic_year_id uuid NOT NULL,
    name text NOT NULL,
    grade_ids uuid[] NOT NULL DEFAULT '{}',
    working_days smallint[] NOT NULL,
    periods jsonb NOT NULL,
    saturday_period_count integer,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (school_id, id),
    FOREIGN KEY (school_id, academic_year_id) REFERENCES academic_years (school_id, id)
);

CREATE TABLE timetable_entries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    school_id uuid NOT NULL REFERENCES schools (id) ON DELETE CASCADE,
    academic_year_id uuid NOT NULL,
    section_id uuid NOT NULL,
    day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 1 AND 6),
    period_index integer NOT NULL CHECK (period_index >= 0),
    subject_id uuid NOT NULL,
    staff_id uuid,
    room_number text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (school_id, academic_year_id, section_id, day_of_week, period_index),
    FOREIGN KEY (school_id, academic_year_id) REFERENCES academic_years (school_id, id),
    FOREIGN KEY (school_id, section_id) REFERENCES sections (school_id, id),
    FOREIGN KEY (school_id, subject_id) REFERENCES subjects (school_id, id),
    FOREIGN KEY (school_id, staff_id) REFERENCES staff (school_id, id)
);

CREATE TABLE substitutions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    school_id uuid NOT NULL REFERENCES schools (id) ON DELETE CASCADE,
    date date NOT NULL,
    section_id uuid NOT NULL,
    period_index integer NOT NULL CHECK (period_index >= 0),
    subject_id uuid NOT NULL,
    absent_staff_id uuid NOT NULL,
    substitute_staff_id uuid,
    reason text,
    notified boolean NOT NULL DEFAULT FALSE,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (school_id, date, section_id, period_index),
    FOREIGN KEY (school_id, section_id) REFERENCES sections (school_id, id),
    FOREIGN KEY (school_id, subject_id) REFERENCES subjects (school_id, id),
    FOREIGN KEY (school_id, absent_staff_id) REFERENCES staff (school_id, id),
    FOREIGN KEY (school_id, substitute_staff_id) REFERENCES staff (school_id, id)
);

CREATE TABLE membership_staff_links (
    school_id uuid NOT NULL,
    membership_id uuid NOT NULL,
    staff_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (school_id, membership_id),
    UNIQUE (school_id, staff_id),
    FOREIGN KEY (school_id, membership_id) REFERENCES school_memberships (school_id, id) ON DELETE CASCADE,
    FOREIGN KEY (school_id, staff_id) REFERENCES staff (school_id, id) ON DELETE RESTRICT
);

CREATE TABLE membership_guardian_links (
    school_id uuid NOT NULL,
    membership_id uuid NOT NULL,
    guardian_id uuid NOT NULL,
    verified_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (school_id, membership_id),
    UNIQUE (school_id, guardian_id),
    FOREIGN KEY (school_id, membership_id) REFERENCES school_memberships (school_id, id) ON DELETE CASCADE,
    FOREIGN KEY (school_id, guardian_id) REFERENCES guardians (school_id, id) ON DELETE RESTRICT
);

CREATE TABLE membership_student_links (
    school_id uuid NOT NULL,
    membership_id uuid NOT NULL,
    student_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (school_id, membership_id),
    UNIQUE (school_id, student_id),
    FOREIGN KEY (school_id, membership_id) REFERENCES school_memberships (school_id, id) ON DELETE CASCADE,
    FOREIGN KEY (school_id, student_id) REFERENCES students (school_id, id) ON DELETE RESTRICT
);

CREATE TABLE guardian_student_access (
    school_id uuid NOT NULL,
    guardian_id uuid NOT NULL,
    student_id uuid NOT NULL,
    status text NOT NULL CHECK (status IN ('approved', 'revoked')),
    areas text[] NOT NULL,
    approved_by_membership_id uuid NOT NULL,
    approved_at timestamptz NOT NULL,
    revoked_at timestamptz,
    PRIMARY KEY (school_id, guardian_id, student_id),
    FOREIGN KEY (school_id, guardian_id) REFERENCES guardians (school_id, id),
    FOREIGN KEY (school_id, student_id) REFERENCES students (school_id, id),
    FOREIGN KEY (school_id, approved_by_membership_id) REFERENCES school_memberships (school_id, id)
);

CREATE TABLE school_invitations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    school_id uuid NOT NULL REFERENCES schools (id) ON DELETE CASCADE,
    identifier_type text NOT NULL CHECK (identifier_type IN ('email', 'phone')),
    identifier_normalized text NOT NULL,
    destination_masked text NOT NULL,
    token_digest text NOT NULL UNIQUE,
    status invitation_status NOT NULL DEFAULT 'pending',
    proposed_role_keys text[] NOT NULL,
    staff_id uuid,
    inviter_membership_id uuid NOT NULL,
    expires_at timestamptz NOT NULL,
    accepted_at timestamptz,
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (school_id, staff_id) REFERENCES staff (school_id, id),
    FOREIGN KEY (school_id, inviter_membership_id) REFERENCES school_memberships (school_id, id)
);

CREATE UNIQUE INDEX school_invitation_one_pending_destination ON school_invitations (school_id, identifier_type, identifier_normalized)
WHERE
    status = 'pending';

CREATE TABLE resource_access_rules (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    school_id uuid NOT NULL REFERENCES schools (id) ON DELETE CASCADE,
    membership_id uuid NOT NULL,
    permission text NOT NULL,
    effect access_effect NOT NULL,
    target_type text NOT NULL CHECK (target_type IN ('school', 'section', 'student', 'staff', 'document')),
    section_id uuid,
    student_id uuid,
    staff_id uuid,
    document_id uuid,
    effective_from timestamptz NOT NULL,
    expires_at timestamptz,
    revoked_at timestamptz,
    reason text NOT NULL,
    author_membership_id uuid NOT NULL,
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (expires_at IS NULL OR effective_from < expires_at),
    CHECK ((target_type = 'school' AND section_id IS NULL AND student_id IS NULL AND staff_id IS NULL AND document_id IS NULL) OR (target_type = 'section' AND section_id IS NOT NULL AND student_id IS NULL AND staff_id IS NULL AND document_id IS NULL) OR (target_type = 'student' AND section_id IS NULL AND student_id IS NOT NULL AND staff_id IS NULL AND document_id IS NULL) OR (target_type = 'staff' AND section_id IS NULL AND student_id IS NULL AND staff_id IS NOT NULL AND document_id IS NULL) OR (target_type = 'document' AND section_id IS NULL AND student_id IS NULL AND staff_id IS NULL AND document_id IS NOT NULL)),
    FOREIGN KEY (school_id, membership_id) REFERENCES school_memberships (school_id, id),
    FOREIGN KEY (school_id, author_membership_id) REFERENCES school_memberships (school_id, id),
    FOREIGN KEY (school_id, section_id) REFERENCES sections (school_id, id),
    FOREIGN KEY (school_id, student_id) REFERENCES students (school_id, id),
    FOREIGN KEY (school_id, staff_id) REFERENCES staff (school_id, id),
    FOREIGN KEY (school_id, document_id) REFERENCES student_documents (school_id, id)
);

CREATE INDEX resource_access_rules_decision_idx ON resource_access_rules (school_id, membership_id, permission, expires_at);

CREATE TABLE audit_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    school_id uuid NOT NULL REFERENCES schools (id) ON DELETE RESTRICT,
    actor_user_id uuid REFERENCES auth_user (id) ON DELETE SET NULL,
    actor_membership_id uuid,
    action text NOT NULL,
    target_type text NOT NULL,
    target_id uuid,
    result text NOT NULL CHECK (result IN ('allowed', 'denied', 'failed')),
    summary text NOT NULL,
    safe_changes jsonb NOT NULL DEFAULT '{}'::jsonb,
    request_id text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (school_id, actor_membership_id) REFERENCES school_memberships (school_id, id)
);

CREATE INDEX audit_events_school_created_idx ON audit_events (school_id, created_at DESC);

CREATE TABLE delivery_outbox (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    school_id uuid NOT NULL REFERENCES schools (id) ON DELETE RESTRICT,
    event_type text NOT NULL,
    destination text NOT NULL,
    payload jsonb NOT NULL,
    status delivery_status NOT NULL DEFAULT 'queued',
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    available_at timestamptz NOT NULL DEFAULT now(),
    locked_at timestamptz,
    delivered_at timestamptz,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX delivery_outbox_ready_idx ON delivery_outbox (status, available_at);

-- A membership must use the matching kind. Constraints are deferred so an
-- invitation acceptance transaction can create both records atomically.
CREATE FUNCTION enforce_membership_link_kind ()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    k membership_kind;
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
    IF TG_TABLE_NAME = 'membership_staff_links' AND k <> 'adult' THEN
        RAISE EXCEPTION 'staff link requires adult membership';
    END IF;
    IF TG_TABLE_NAME = 'membership_guardian_links' AND k <> 'adult' THEN
        RAISE EXCEPTION 'guardian link requires adult membership';
    END IF;
    IF TG_TABLE_NAME = 'membership_student_links' AND k <> 'student' THEN
        RAISE EXCEPTION 'student link requires student membership';
    END IF;
    RETURN NEW;
END
$$;

CREATE CONSTRAINT TRIGGER membership_staff_kind
    AFTER INSERT OR UPDATE ON membership_staff_links DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION enforce_membership_link_kind ();

CREATE CONSTRAINT TRIGGER membership_guardian_kind
    AFTER INSERT OR UPDATE ON membership_guardian_links DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION enforce_membership_link_kind ();

CREATE CONSTRAINT TRIGGER membership_student_kind
    AFTER INSERT OR UPDATE ON membership_student_links DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION enforce_membership_link_kind ();

CREATE FUNCTION reject_bad_exception_permission ()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF (NEW.target_type = 'section' AND NEW.permission NOT IN ('students.read_basic', 'students.export', 'timetable.read')) OR (NEW.target_type = 'student' AND NEW.permission NOT IN ('students.read_basic')) OR (NEW.target_type = 'staff' AND NEW.permission NOT IN ('staff.read_directory')) OR (NEW.target_type = 'document' AND NEW.permission NOT IN ('students.read_documents', 'students.download_documents')) OR (NEW.target_type = 'school' AND NEW.permission NOT IN ('students.read_basic', 'students.export', 'staff.read_directory')) THEN
        RAISE EXCEPTION 'permission % is not supported for % exception target', NEW.permission, NEW.target_type;
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER resource_access_rule_catalogue
    BEFORE INSERT OR UPDATE ON resource_access_rules
    FOR EACH ROW
    EXECUTE FUNCTION reject_bad_exception_permission ();

CREATE FUNCTION prevent_invitation_terminal_revival ()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF OLD.status <> 'pending' THEN
        RAISE EXCEPTION 'terminal invitation is immutable';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER invitation_terminal_revival
    BEFORE UPDATE ON school_invitations
    FOR EACH ROW
    EXECUTE FUNCTION prevent_invitation_terminal_revival ();

CREATE FUNCTION audit_immutable ()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'audit history is append-only';
END
$$;

CREATE TRIGGER audit_no_update
    BEFORE UPDATE OR DELETE ON audit_events
    FOR EACH ROW
    EXECUTE FUNCTION audit_immutable ();

-- RLS is a second line of defence. The only runtime role is erp_runtime and it
-- must SET LOCAL app.school_id through withTenantTransaction(). The migrator is
-- intentionally separate and is the only owner of schema/catalogue objects.
DO $$
BEGIN
    CREATE ROLE erp_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
EXCEPTION
    WHEN duplicate_object THEN
        NULL;
END
$$;

DO $$
BEGIN
    CREATE ROLE erp_identity NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
EXCEPTION
    WHEN duplicate_object THEN
        NULL;
END
$$;

DO $$
BEGIN
    CREATE ROLE erp_auth NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
EXCEPTION
    WHEN duplicate_object THEN
        NULL;
END
$$;

ALTER TABLE schools ENABLE ROW LEVEL SECURITY;

ALTER TABLE schools FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_schools ON schools
    USING (id = NULLIF (current_setting('app.school_id', TRUE), '')::uuid) WITH CHECK (id = NULLIF(current_setting('app.school_id', true), '')::uuid);

DO $$
DECLARE
    table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY['school_memberships', 'roles', 'role_permissions', 'membership_roles', 'academic_years', 'grades', 'staff', 'sections', 'subjects', 'grade_subjects', 'holidays', 'students', 'guardians', 'enrollments', 'student_guardians', 'student_documents', 'teaching_assignments', 'bell_schedules', 'timetable_entries', 'substitutions', 'membership_staff_links', 'membership_guardian_links', 'membership_student_links', 'guardian_student_access', 'school_invitations', 'resource_access_rules', 'audit_events', 'delivery_outbox'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
        EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (school_id = NULLIF(current_setting(''app.school_id'', true), '''')::uuid) WITH CHECK (school_id = NULLIF(current_setting(''app.school_id'', true), '''')::uuid)', table_name);
    END LOOP;
END
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON schools, school_memberships, membership_roles, academic_years, grades, staff, sections, subjects, grade_subjects, holidays, students, guardians, enrollments, student_guardians, student_documents, teaching_assignments, bell_schedules, timetable_entries, substitutions, membership_staff_links, membership_guardian_links, membership_student_links, guardian_student_access, school_invitations, resource_access_rules, delivery_outbox TO erp_runtime;

GRANT SELECT, INSERT ON audit_events TO erp_runtime;

GRANT SELECT (id, name, email, email_verified, phone_number, phone_number_verified, two_factor_enabled) ON auth_user TO erp_identity;

GRANT SELECT (id, school_id, user_id, kind, status, version, access_version) ON school_memberships TO erp_identity;

GRANT SELECT, INSERT, UPDATE, DELETE ON auth_user, auth_session, auth_account, auth_verification, auth_two_factor TO erp_auth;
