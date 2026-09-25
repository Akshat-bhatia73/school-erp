-- Member restrictions (September 2026).
--
-- An owner or principal can take one sensitive student field away from one
-- member across the whole school: the sensitive block (Aadhaar, APAAR and the
-- like), full guardian records (PAN, Aadhaar, office address) or medical
-- information. A restriction is an ordinary resource_access_rules row with
-- effect 'deny' on the school target, so the existing decision, list
-- predicate and access version protocol already honour it.
--
-- The catalogue trigger accepted only a short list of permissions per target.
-- It now also accepts the three restrictable keys on the school target, and
-- only as a deny: an allow for them would widen access beyond what a role
-- gives, which no screen or route may do.
--
-- Additive: the release before this one never writes such a row, and reads
-- one through the same deny path it already has.

CREATE OR REPLACE FUNCTION reject_bad_exception_permission ()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.target_type = 'school'
        AND NEW.permission IN ('students.read_sensitive', 'students.read_guardians', 'students.read_medical') THEN
        IF NEW.effect <> 'deny' THEN
            RAISE EXCEPTION 'permission % can only be restricted', NEW.permission;
        END IF;
        RETURN NEW;
    END IF;
    IF (NEW.target_type = 'section' AND NEW.permission NOT IN ('students.read_basic', 'students.export', 'timetable.read')) OR (NEW.target_type = 'student' AND NEW.permission NOT IN ('students.read_basic')) OR (NEW.target_type = 'staff' AND NEW.permission NOT IN ('staff.read_directory')) OR (NEW.target_type = 'document' AND NEW.permission NOT IN ('students.read_documents', 'students.download_documents')) OR (NEW.target_type = 'school' AND NEW.permission NOT IN ('students.read_basic', 'students.export', 'staff.read_directory')) THEN
        RAISE EXCEPTION 'permission % is not supported for % exception target', NEW.permission, NEW.target_type;
    END IF;
    RETURN NEW;
END
$$;
