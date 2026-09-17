-- Identity lookup happens before a tenant context exists. Keep its capability
-- in one security-definer function instead of granting table reads to callers.
DO $$
BEGIN
    CREATE ROLE erp_identity_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
EXCEPTION
    WHEN duplicate_object THEN
        NULL;
END
$$;

REVOKE SELECT ON auth_user, school_memberships FROM erp_identity;

REVOKE ALL ON schools, school_memberships FROM erp_identity;

GRANT USAGE ON SCHEMA public TO erp_identity, erp_identity_reader;

GRANT SELECT (id, school_id, user_id, kind, status, version, access_version) ON school_memberships TO erp_identity_reader;

GRANT SELECT (id, status) ON schools TO erp_identity_reader;

CREATE POLICY identity_bootstrap ON schools
    FOR SELECT TO erp_identity_reader
    USING (CURRENT_USER = 'erp_identity_reader');

CREATE POLICY identity_bootstrap ON school_memberships
    FOR SELECT TO erp_identity_reader
    USING (CURRENT_USER = 'erp_identity_reader');

CREATE FUNCTION active_adult_memberships_for_user (identity_user_id uuid)
    RETURNS TABLE (
        membership_id uuid,
        school_id uuid,
        version integer,
        access_version integer)
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = pg_catalog,
    public
    AS $$
    SELECT
        membership.id,
        membership.school_id,
        membership.version,
        membership.access_version
    FROM
        public.school_memberships AS membership
        JOIN public.schools AS school ON school.id = membership.school_id
    WHERE
        membership.user_id = identity_user_id
        AND membership.kind = 'adult'
        AND membership.status = 'active'
        AND school.status IN ('active', 'trial')
$$;

ALTER FUNCTION active_adult_memberships_for_user (uuid) OWNER TO erp_identity_reader;

REVOKE ALL ON FUNCTION active_adult_memberships_for_user (uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION active_adult_memberships_for_user (uuid) FROM erp_runtime, erp_auth;

GRANT EXECUTE ON FUNCTION active_adult_memberships_for_user (uuid) TO erp_identity;
