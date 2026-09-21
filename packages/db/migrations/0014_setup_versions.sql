-- Real edit counters for the school profile, holidays and bell schedules.
--
-- These three tables were the only editable records without a version column.
-- The school profile and a holiday compared the moment of the last save, in
-- microseconds, and a bell schedule answered version 1 for ever and refused
-- any other number, so two people editing one bell schedule could not be told
-- apart. Every other record uses the counter that bumpVersion raises, and now
-- these do too.
--
-- The change is additive: a column with a default, so the release before this
-- one keeps running against it and simply ignores the column. Every existing
-- row starts at 1. None of this changes who may read or write a row: the
-- grants are table level and RLS already covers all three tables.
ALTER TABLE schools
    ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);

ALTER TABLE holidays
    ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);

ALTER TABLE bell_schedules
    ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);
