-- Migrator role bootstrap.
--
-- Later migrations hand SECURITY DEFINER functions to two NOLOGIN roles:
-- 0002 gives active_adult_memberships_for_user to erp_identity_reader, and
-- 0009/0010 give the sweep functions to erp_maintenance. PostgreSQL asks two
-- things of whoever runs ALTER FUNCTION ... OWNER TO <role>:
--
--   1. the migrator must be a member of the new owner role, otherwise the
--      server answers "must be able to SET ROLE <role>";
--   2. the new owner must hold CREATE on the function's schema, otherwise the
--      server answers "permission denied for schema public".
--
-- A superuser migrator satisfies both implicitly, which is why local runs and
-- CI never noticed. A managed database (Neon) hands out a database owner with
-- CREATEROLE but no superuser, and there both checks fail. This file creates
-- the two roles, grants them USAGE and CREATE on public, and grants their
-- membership to whoever is running the migration. It has to sort after
-- 0001_domain_integrity.sql and before 0002_identity_bootstrap.sql, because
-- 0002 is the first migration that transfers ownership; readdir order is the
-- run order, so the "_z_" in the name places it there. The CREATE ROLE blocks
-- are the same idempotent DO blocks 0002 and 0009 use, so their own CREATE
-- ROLE stays a harmless no-op. Every statement here is safe for a superuser
-- migrator too.
DO $$
BEGIN
    CREATE ROLE erp_identity_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
EXCEPTION
    WHEN duplicate_object THEN
        NULL;
END
$$;

DO $$
BEGIN
    CREATE ROLE erp_maintenance NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
EXCEPTION
    WHEN duplicate_object THEN
        NULL;
END
$$;

-- CREATE is what ALTER FUNCTION ... OWNER TO checks against the schema; it is
-- taken away again by 0011_revoke_bootstrap_create.sql once the transfers are
-- done. USAGE is the lasting grant and the later migrations repeat it.
GRANT USAGE, CREATE ON SCHEMA public TO erp_identity_reader;

GRANT USAGE, CREATE ON SCHEMA public TO erp_maintenance;

-- current_user is the migrator, which differs per environment, so the grants
-- are formatted at run time. A migrator that is already a member (a superuser,
-- or a second run) needs nothing; only the first run does the work. When the
-- roles were made by somebody else and this migrator holds no ADMIN option on
-- them, the grant cannot be done from here and the operator has to run it
-- once, so say exactly that instead of failing three migrations later.
DO $$
DECLARE
    member text;
BEGIN
    FOREACH member IN ARRAY ARRAY['erp_identity_reader', 'erp_maintenance']
    LOOP
        CONTINUE
        WHEN pg_has_role (current_user, member, 'MEMBER');
        BEGIN
            EXECUTE format('GRANT %I TO %I', member, current_user);
        EXCEPTION
            WHEN insufficient_privilege THEN
                RAISE EXCEPTION 'The migrator % is not a member of % and cannot grant it. Run: GRANT % TO %;', current_user, member, member, current_user;
        END;
    END LOOP;
END
$$;
