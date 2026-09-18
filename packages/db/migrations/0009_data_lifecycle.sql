-- Task 12: data lifecycle and consent.
--
-- Three things arrive together. Consent becomes a record of events, because a
-- school has to be able to show what a guardian agreed to and when, and the
-- current state of a purpose is simply its newest row. Free reason text moves
-- out of audit_events.safe_changes into its own table, so a note can be
-- redacted without rewriting append-only history. And the transient copies of
-- personal data (staged imports, finished exports, delivered messages, spent
-- invitations, abandoned sessions) get an owner that can sweep them across
-- every school without any login gaining BYPASSRLS.
CREATE TABLE guardian_consents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    school_id uuid NOT NULL REFERENCES schools (id) ON DELETE CASCADE,
    student_id uuid NOT NULL,
    guardian_id uuid NOT NULL,
    purpose text NOT NULL CHECK (purpose IN ('education_records', 'health_information', 'photographs', 'communication', 'third_party_services')),
    status text NOT NULL CHECK (status IN ('given', 'withdrawn')),
    method text NOT NULL CHECK (method IN ('in_person', 'signed_form', 'portal')),
    recorded_by_membership_id uuid NOT NULL,
    evidence_reference text,
    recorded_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (school_id, id),
    FOREIGN KEY (school_id, student_id) REFERENCES students (school_id, id),
    FOREIGN KEY (school_id, guardian_id) REFERENCES guardians (school_id, id),
    FOREIGN KEY (school_id, recorded_by_membership_id) REFERENCES school_memberships (school_id, id)
);

CREATE INDEX guardian_consents_current_idx ON guardian_consents (school_id, student_id, guardian_id, purpose, recorded_at DESC);

-- Every row is an event: the newest row for a purpose is the current answer,
-- so nothing may be edited away.
CREATE FUNCTION consent_append_only ()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'consent history is append-only';
END
$$;

CREATE TRIGGER guardian_consents_no_update
    BEFORE UPDATE OR DELETE ON guardian_consents
    FOR EACH ROW
    EXECUTE FUNCTION consent_append_only ();

-- The reason somebody gives for a pay change or a removal is their words, not
-- structure. It lives here so audit_events.safe_changes stays free of request
-- text and so a note can be redacted while the event itself never changes.
CREATE TABLE audit_event_notes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    school_id uuid NOT NULL REFERENCES schools (id) ON DELETE RESTRICT,
    audit_event_id uuid NOT NULL UNIQUE REFERENCES audit_events (id),
    note text NOT NULL,
    redacted_at timestamptz,
    redacted_by_membership_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (school_id, id),
    FOREIGN KEY (school_id, redacted_by_membership_id) REFERENCES school_memberships (school_id, id)
);

DO $$
DECLARE
    table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY['guardian_consents', 'audit_event_notes'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
        EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (school_id = NULLIF(current_setting(''app.school_id'', true), '''')::uuid) WITH CHECK (school_id = NULLIF(current_setting(''app.school_id'', true), '''')::uuid)', table_name);
    END LOOP;
END
$$;

REVOKE ALL ON guardian_consents, audit_event_notes FROM PUBLIC;

GRANT SELECT, INSERT ON guardian_consents TO erp_runtime;

GRANT SELECT, INSERT, UPDATE ON audit_event_notes TO erp_runtime;

-- Anonymisation needs somewhere to say it happened, and the APAAR id is sealed
-- in the API: the database keeps only the ciphertext and the last four digits
-- it is allowed to show. Photographs are not held at all. The only data today
-- is fixture and seed data, so the old columns go in one step.
ALTER TABLE students
    ADD COLUMN anonymised_at timestamptz,
    ADD COLUMN apaar_last4 text,
    ADD COLUMN apaar_ciphertext text,
    DROP COLUMN apaar_id,
    DROP COLUMN photo_url;

ALTER TABLE guardians
    ADD COLUMN anonymised_at timestamptz,
    DROP COLUMN photo_url;

ALTER TABLE staff
    ADD COLUMN anonymised_at timestamptz,
    DROP COLUMN photo_url;

-- Removing a person is a status change plus anonymisation, never a DELETE: the
-- register row, the audit trail and the documents list have to keep their
-- shape. No API code deletes from these tables, so the login loses the right.
REVOKE DELETE ON students, guardians, staff, student_documents FROM erp_runtime;

-- The sweep crosses every school, which no request-scoped login may do. It
-- runs as a role of its own with its own permissive policies on the transient
-- tables only, following the erp_identity_reader pattern: security definer
-- functions, no BYPASSRLS anywhere.
DO $$
BEGIN
    CREATE ROLE erp_maintenance NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
EXCEPTION
    WHEN duplicate_object THEN
        NULL;
END
$$;

GRANT USAGE ON SCHEMA public TO erp_maintenance;

CREATE POLICY maintenance_sweep ON student_import_previews
    FOR ALL TO erp_maintenance
        USING (TRUE)
        WITH CHECK (TRUE);

CREATE POLICY maintenance_sweep ON export_jobs
    FOR ALL TO erp_maintenance
        USING (TRUE)
        WITH CHECK (TRUE);

CREATE POLICY maintenance_sweep ON delivery_outbox
    FOR ALL TO erp_maintenance
        USING (TRUE)
        WITH CHECK (TRUE);

CREATE POLICY maintenance_sweep ON school_invitations
    FOR ALL TO erp_maintenance
        USING (TRUE)
        WITH CHECK (TRUE);

CREATE POLICY maintenance_read_memberships ON school_memberships
    FOR SELECT TO erp_maintenance
        USING (TRUE);

GRANT SELECT, DELETE ON student_import_previews, export_jobs, delivery_outbox TO erp_maintenance;

GRANT SELECT, UPDATE, DELETE ON school_invitations TO erp_maintenance;

GRANT SELECT ON school_memberships TO erp_maintenance;

GRANT SELECT, DELETE ON auth_session, auth_account, auth_two_factor, auth_verification, auth_throttle, held_sms TO erp_maintenance;

GRANT SELECT, UPDATE ON auth_user TO erp_maintenance;

-- A spent invitation keeps its status and its digest so a replayed token is
-- still recognised and refused; only the contact it was sent to is blanked.
CREATE OR REPLACE FUNCTION prevent_invitation_terminal_revival ()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    blanked school_invitations%ROWTYPE;
BEGIN
    IF OLD.status <> 'pending' THEN
        IF NEW.identifier_normalized = '' AND OLD.identifier_normalized <> '' THEN
            blanked := OLD;
            blanked.identifier_normalized := '';
            blanked.updated_at := NEW.updated_at;
            IF NEW IS NOT DISTINCT FROM blanked THEN
                RETURN NEW;
            END IF;
        END IF;
        RAISE EXCEPTION 'terminal invitation is immutable';
    END IF;
    RETURN NEW;
END
$$;

CREATE FUNCTION sweep_tenant_transients ()
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
    DELETE FROM public.student_import_previews
    WHERE expires_at < now()
        OR (status = 'committed'
            AND updated_at < now() - interval '1 day');
    GET DIAGNOSTICS removed = ROW_COUNT;
    item := 'import_previews';
    count := removed;
    RETURN NEXT;
    DELETE FROM public.export_jobs
    WHERE expires_at < now() - interval '1 day';
    GET DIAGNOSTICS removed = ROW_COUNT;
    item := 'export_jobs';
    count := removed;
    RETURN NEXT;
    DELETE FROM public.delivery_outbox
    WHERE status IN ('sent', 'failed', 'dead_letter')
        AND COALESCE(delivered_at, created_at) < now() - interval '90 days';
    GET DIAGNOSTICS removed = ROW_COUNT;
    item := 'delivery_outbox';
    count := removed;
    RETURN NEXT;
    UPDATE
        public.school_invitations
    SET
        identifier_normalized = ''
    WHERE
        status <> 'pending'
        AND identifier_normalized <> '';
    GET DIAGNOSTICS removed = ROW_COUNT;
    item := 'invitations_blanked';
    count := removed;
    RETURN NEXT;
    DELETE FROM public.school_invitations
    WHERE status <> 'pending'
        AND updated_at < now() - interval '90 days';
    GET DIAGNOSTICS removed = ROW_COUNT;
    item := 'invitations_removed';
    count := removed;
    RETURN NEXT;
END
$$;

ALTER FUNCTION sweep_tenant_transients () OWNER TO erp_maintenance;

REVOKE ALL ON FUNCTION sweep_tenant_transients () FROM PUBLIC;

GRANT EXECUTE ON FUNCTION sweep_tenant_transients () TO erp_runtime;

CREATE FUNCTION sweep_auth_transients ()
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
    DELETE FROM public.auth_verification
    WHERE expires_at < now();
    GET DIAGNOSTICS removed = ROW_COUNT;
    item := 'verifications';
    count := removed;
    RETURN NEXT;
    DELETE FROM public.auth_session
    WHERE expires_at < now();
    GET DIAGNOSTICS removed = ROW_COUNT;
    item := 'sessions';
    count := removed;
    RETURN NEXT;
    DELETE FROM public.auth_throttle
    WHERE expires_at < now();
    GET DIAGNOSTICS removed = ROW_COUNT;
    item := 'throttles';
    count := removed;
    RETURN NEXT;
    DELETE FROM public.held_sms
    WHERE expires_at < now();
    GET DIAGNOSTICS removed = ROW_COUNT;
    item := 'held_sms';
    count := removed;
    RETURN NEXT;
END
$$;

ALTER FUNCTION sweep_auth_transients () OWNER TO erp_maintenance;

REVOKE ALL ON FUNCTION sweep_auth_transients () FROM PUBLIC;

GRANT EXECUTE ON FUNCTION sweep_auth_transients () TO erp_auth;

-- Login credentials outlive the membership that justified them by the grace
-- period and no longer. The name and the id stay so an old audit row still
-- says who did the thing.
CREATE FUNCTION sweep_orphaned_credentials (grace interval)
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
    orphans uuid[];
BEGIN
    SELECT
        COALESCE(array_agg(candidate.id), '{}')
    INTO orphans
    FROM
        public.auth_user AS candidate
    WHERE
        candidate.email NOT LIKE 'removed+%@invalid.local'
        AND NOT EXISTS (
            SELECT
                1
            FROM
                public.school_memberships AS membership
            WHERE
                membership.user_id = candidate.id
                AND membership.status IN ('active', 'suspended'))
        AND COALESCE((
            SELECT
                max(membership.updated_at)
            FROM public.school_memberships AS membership
            WHERE
                membership.user_id = candidate.id), candidate.created_at) < now() - grace;
    DELETE FROM public.auth_session
    WHERE user_id = ANY (orphans);
    GET DIAGNOSTICS removed = ROW_COUNT;
    item := 'sessions';
    count := removed;
    RETURN NEXT;
    DELETE FROM public.auth_account
    WHERE user_id = ANY (orphans);
    GET DIAGNOSTICS removed = ROW_COUNT;
    item := 'accounts';
    count := removed;
    RETURN NEXT;
    DELETE FROM public.auth_two_factor
    WHERE user_id = ANY (orphans);
    GET DIAGNOSTICS removed = ROW_COUNT;
    item := 'two_factor';
    count := removed;
    RETURN NEXT;
    UPDATE
        public.auth_user
    SET
        email = 'removed+' || id::text || '@invalid.local',
        email_verified = FALSE,
        phone_number = NULL,
        phone_number_verified = FALSE,
        two_factor_enabled = FALSE,
        image = NULL,
        updated_at = now()
    WHERE
        id = ANY (orphans);
    GET DIAGNOSTICS removed = ROW_COUNT;
    item := 'users';
    count := removed;
    RETURN NEXT;
END
$$;

ALTER FUNCTION sweep_orphaned_credentials (interval) OWNER TO erp_maintenance;

REVOKE ALL ON FUNCTION sweep_orphaned_credentials (interval) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION sweep_orphaned_credentials (interval) TO erp_auth;
