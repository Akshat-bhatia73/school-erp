-- Authentication service support: session assurance timestamp, a shared rate
-- limit store for the API instances, and a student-membership check the
-- identity role can run before any tenant context exists.
ALTER TABLE auth_session
    ADD COLUMN mfa_verified_at timestamptz;

CREATE TABLE auth_rate_limit (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    key text NOT NULL UNIQUE,
    count integer NOT NULL DEFAULT 0,
    last_request bigint NOT NULL DEFAULT 0
);

-- Global auth infrastructure table: no school_id, therefore no tenant RLS.
REVOKE ALL ON auth_rate_limit FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON auth_rate_limit TO erp_auth;

CREATE FUNCTION user_has_student_membership (identity_user_id uuid)
    RETURNS boolean
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog,
    public
    AS $$
    SELECT
        EXISTS (
            SELECT
                1
            FROM
                public.school_memberships AS membership
            WHERE
                membership.user_id = identity_user_id
                AND membership.kind = 'student')
$$;

ALTER FUNCTION user_has_student_membership (uuid) OWNER TO erp_identity_reader;

REVOKE ALL ON FUNCTION user_has_student_membership (uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION user_has_student_membership (uuid) FROM erp_runtime, erp_auth;

GRANT EXECUTE ON FUNCTION user_has_student_membership (uuid) TO erp_identity;
