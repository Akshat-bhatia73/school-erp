-- Final integrity rules which depend on the domain tables from 0001.
-- Locking the membership row makes role/link writes and kind transitions serialize.
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
    IF NEW.kind = 'student' AND NEW.status = 'active' THEN
        RAISE EXCEPTION 'student memberships remain disabled';
    END IF;
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

CREATE OR REPLACE FUNCTION enforce_role_membership_kind ()
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
        AND id = NEW.membership_id
    FOR UPDATE;
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

CREATE OR REPLACE FUNCTION enforce_membership_link_kind ()
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
        AND id = NEW.membership_id
    FOR UPDATE;
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

ALTER TABLE school_invitations
    ADD COLUMN display_name text NOT NULL DEFAULT '';

CREATE OR REPLACE FUNCTION invitation_role_keys_are_valid (role_keys text[])
    RETURNS boolean IMMUTABLE
    LANGUAGE sql
    AS $$
    SELECT
        cardinality(role_keys) > 0
        AND array_position(role_keys, NULL) IS NULL
        AND cardinality(role_keys) = cardinality(ARRAY ( SELECT DISTINCT
                    unnest(role_keys)))
        AND role_keys <@ ARRAY['principal', 'admin', 'accountant', 'teacher', 'parent']::text[]
$$;

ALTER TABLE school_invitations
    ADD CONSTRAINT invitation_role_keys_valid CHECK (invitation_role_keys_are_valid (proposed_role_keys)),
    ADD CONSTRAINT invitation_staff_requirement CHECK (staff_id IS NOT NULL OR proposed_role_keys = ARRAY['parent']::text[]),
    ADD CONSTRAINT invitation_state_timestamps CHECK (expires_at > created_at AND ((status = 'accepted' AND accepted_at IS NOT NULL) OR (status <> 'accepted' AND accepted_at IS NULL)));
