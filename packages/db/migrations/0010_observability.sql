-- Task 13: observability and incident readiness.
--
-- Two things arrive together. An access log, because Vercel Hobby offers no log
-- drain and Sentry must never hold request data, so our own database is the only
-- sink we control: one row per /api request, the route pattern only, never the
-- URL, the query string or the body. And a durable account lockout on the
-- identity, because counting failed sign-ins in memory forgets them the moment
-- the function instance goes away.
--
-- access_log is global infrastructure like auth_throttle: no school owns it, so
-- it carries no tenant policy. It names ids without foreign keys on purpose, so
-- a row survives the deletion of the person, membership or school it names.
CREATE TABLE access_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    at timestamptz NOT NULL DEFAULT now(),
    method text NOT NULL,
    route text NOT NULL,
    status integer NOT NULL,
    code text,
    user_id uuid,
    membership_id uuid,
    school_id uuid,
    ip_hash text,
    duration_ms integer NOT NULL,
    request_id text NOT NULL
);

CREATE INDEX access_log_at_idx ON access_log (at);

CREATE INDEX access_log_membership_idx ON access_log (membership_id, at);

-- The runtime writes and never reads: nothing in the API answers questions from
-- this table. Reading it is an incident step taken with the migrator login.
REVOKE ALL ON access_log FROM PUBLIC;

GRANT INSERT ON access_log TO erp_runtime;

GRANT SELECT, DELETE ON access_log TO erp_maintenance;

-- Ten failed password sign-ins lock the identity for fifteen minutes, and an
-- operator can disable one outright; both are answered exactly like a wrong
-- password, so a caller cannot tell them apart. erp_auth already holds UPDATE.
ALTER TABLE auth_user
    ADD COLUMN disabled_at timestamptz,
    ADD COLUMN locked_until timestamptz,
    ADD COLUMN failed_sign_ins integer NOT NULL DEFAULT 0;

-- The sweep crosses every school, which no request-scoped login may do; it runs
-- as erp_maintenance through a definer function, as the Task 12 sweeps do.
CREATE FUNCTION sweep_access_log ()
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
    DELETE FROM public.access_log
    WHERE at < now() - interval '180 days';
    GET DIAGNOSTICS removed = ROW_COUNT;
    item := 'access_log';
    count := removed;
    RETURN NEXT;
END
$$;

ALTER FUNCTION sweep_access_log () OWNER TO erp_maintenance;

REVOKE ALL ON FUNCTION sweep_access_log () FROM PUBLIC;

GRANT EXECUTE ON FUNCTION sweep_access_log () TO erp_runtime;
