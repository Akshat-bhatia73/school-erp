-- Task 8: the counters behind server-assigned admission numbers and employee
-- codes.
--
-- One row per (school, kind, period): admissions count per academic year, so
-- the period is the year id; employee codes are one school-wide counter, so
-- the period is empty. next_value is the number the next allocation takes,
-- claimed with a single INSERT ... ON CONFLICT DO UPDATE ... RETURNING inside
-- the same transaction as the record it numbers, so two concurrent admissions
-- cannot read the same counter. The UNIQUE constraints on students and staff
-- stay the last line of defence.
CREATE TABLE number_sequences (
    school_id uuid NOT NULL REFERENCES schools (id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('admission', 'employee')),
    period text NOT NULL DEFAULT '',
    next_value integer NOT NULL DEFAULT 1 CHECK (next_value > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (school_id, kind, period)
);

ALTER TABLE number_sequences ENABLE ROW LEVEL SECURITY;

ALTER TABLE number_sequences FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON number_sequences
    USING (school_id = NULLIF (current_setting('app.school_id', TRUE), '')::uuid) WITH CHECK (school_id = NULLIF(current_setting('app.school_id', true), '')::uuid);

REVOKE ALL ON number_sequences FROM PUBLIC;

-- A counter is never deleted: a school that removed its last student still
-- must not hand the same admission number out twice.
GRANT SELECT, INSERT, UPDATE ON number_sequences TO erp_runtime;
