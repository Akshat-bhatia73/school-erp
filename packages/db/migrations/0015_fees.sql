-- Task 19: fees.
--
-- Six tables. Two describe what the school charges (its own list of fee heads,
-- and the amount of each head for an academic year and a class), two describe
-- one pupil (the optional heads they take, and the concessions they get), and
-- two are the ledger: every payment, refund, cancellation and adjustment, with
-- the amount of each split by fee head.
--
-- Money is integer paise in a bigint everywhere. Nothing here is a float.
--
-- The change is additive: new tables, and two CHECK constraints widened by one
-- or three values. The release before this one keeps running against it and
-- never sees the new tables.
--
-- The school's own list of what it charges. The name is the school's; the
-- category only groups heads on a screen and in a file, so a school can name a
-- head anything it likes.
CREATE TABLE fee_heads (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    school_id uuid NOT NULL REFERENCES schools (id) ON DELETE CASCADE,
    name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
    category text NOT NULL CHECK (category IN ('tuition', 'admission', 'transport', 'lab', 'sports', 'activity', 'library', 'exam', 'uniform', 'hostel', 'late_fee', 'other')),
    -- 'class' is charged to every pupil of a class that has a structure row;
    -- 'opt_in' only to a pupil who has a fee_student_heads row for it.
    applies_to text NOT NULL CHECK (applies_to IN ('class', 'opt_in')),
    frequency text NOT NULL CHECK (frequency IN ('one_time', 'yearly', 'half_yearly', 'quarterly', 'monthly')),
    active boolean NOT NULL DEFAULT TRUE,
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (school_id, id)
);

CREATE UNIQUE INDEX fee_heads_name_unique ON fee_heads (school_id, lower(btrim(name)));

-- The amount of one head, per instalment, for one academic year. A row with
-- no class is the amount for every class; a row that names a class wins over
-- it for that class.
CREATE TABLE fee_structures (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    school_id uuid NOT NULL REFERENCES schools (id) ON DELETE CASCADE,
    academic_year_id uuid NOT NULL,
    fee_head_id uuid NOT NULL,
    grade_id uuid,
    amount_paise bigint NOT NULL CHECK (amount_paise > 0 AND amount_paise <= 100000000000),
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (school_id, id),
    FOREIGN KEY (school_id, academic_year_id) REFERENCES academic_years (school_id, id),
    FOREIGN KEY (school_id, fee_head_id) REFERENCES fee_heads (school_id, id),
    FOREIGN KEY (school_id, grade_id) REFERENCES grades (school_id, id)
);

-- One amount per year, head and class, where "no class" is a value of its own.
CREATE UNIQUE INDEX fee_structures_unique ON fee_structures (school_id, academic_year_id, fee_head_id, COALESCE(grade_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- An optional head one pupil takes: the bus, a sport, a club. The amount is
-- the structure's unless this row names its own, which is how a bus fare
-- differs by route. The dates bound the instalments that are charged.
CREATE TABLE fee_student_heads (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    school_id uuid NOT NULL REFERENCES schools (id) ON DELETE CASCADE,
    student_id uuid NOT NULL,
    academic_year_id uuid NOT NULL,
    fee_head_id uuid NOT NULL,
    amount_paise bigint CHECK (amount_paise IS NULL OR (amount_paise > 0 AND amount_paise <= 100000000000)),
    starts_on date NOT NULL,
    ends_on date,
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (school_id, id),
    UNIQUE (school_id, student_id, academic_year_id, fee_head_id),
    CHECK (ends_on IS NULL OR ends_on >= starts_on),
    FOREIGN KEY (school_id, student_id) REFERENCES students (school_id, id),
    FOREIGN KEY (school_id, academic_year_id) REFERENCES academic_years (school_id, id),
    FOREIGN KEY (school_id, fee_head_id) REFERENCES fee_heads (school_id, id)
);

-- A concession for one pupil in one year: a share of every instalment, in
-- basis points, or an amount off every instalment of one head. The category is
-- a closed list; the reason somebody typed lives in the audit note only, so a
-- hardship story is never a column here.
CREATE TABLE fee_concessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    school_id uuid NOT NULL REFERENCES schools (id) ON DELETE CASCADE,
    student_id uuid NOT NULL,
    academic_year_id uuid NOT NULL,
    -- No head means the concession applies to every head.
    fee_head_id uuid,
    category text NOT NULL CHECK (category IN ('sibling', 'staff_child', 'scholarship', 'hardship', 'other')),
    kind text NOT NULL CHECK (kind IN ('percent', 'amount')),
    percent_bp integer CHECK (percent_bp IS NULL OR (percent_bp > 0 AND percent_bp <= 10000)),
    amount_paise bigint CHECK (amount_paise IS NULL OR (amount_paise > 0 AND amount_paise <= 100000000000)),
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (school_id, id),
    CHECK ((kind = 'percent' AND percent_bp IS NOT NULL AND amount_paise IS NULL) OR (kind = 'amount' AND amount_paise IS NOT NULL AND percent_bp IS NULL AND fee_head_id IS NOT NULL)),
    FOREIGN KEY (school_id, student_id) REFERENCES students (school_id, id),
    FOREIGN KEY (school_id, academic_year_id) REFERENCES academic_years (school_id, id),
    FOREIGN KEY (school_id, fee_head_id) REFERENCES fee_heads (school_id, id)
);

CREATE INDEX fee_concessions_student_idx ON fee_concessions (school_id, student_id, academic_year_id);

-- The ledger. Every row is an event and none is ever edited: a refund, a
-- cancellation or a correction is a new row that points at the old one through
-- reverses_receipt_id. amount_paise is always positive and the kind says which
-- way the money went.
CREATE TABLE fee_receipts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    school_id uuid NOT NULL REFERENCES schools (id) ON DELETE RESTRICT,
    student_id uuid NOT NULL,
    academic_year_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('payment', 'refund', 'cancellation', 'credit_adjustment', 'debit_adjustment')),
    -- Assigned by the server from number_sequences, never sent by a caller.
    receipt_number text NOT NULL CHECK (length(receipt_number) BETWEEN 1 AND 60),
    amount_paise bigint NOT NULL CHECK (amount_paise > 0 AND amount_paise <= 100000000000),
    -- How the money moved. An adjustment and a cancellation move none.
    mode text CHECK (mode IS NULL OR mode IN ('cash', 'cheque', 'upi', 'bank_transfer', 'demand_draft')),
    -- The cheque number, the UPI or bank reference, the draft number.
    reference text CHECK (reference IS NULL OR length(reference) <= 80),
    -- The day the office says the money moved, not the moment it was typed in.
    received_on date NOT NULL,
    -- The one identifying column beyond the pupil. Anonymising the pupil sets
    -- it to NULL, and that is the only edit the trigger below allows.
    payer_name text CHECK (payer_name IS NULL OR length(payer_name) <= 120),
    reverses_receipt_id uuid,
    recorded_by_membership_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (school_id, id),
    UNIQUE (school_id, receipt_number),
    CHECK ((kind IN ('payment', 'refund')) = (mode IS NOT NULL)),
    CHECK ((kind IN ('refund', 'cancellation')) = (reverses_receipt_id IS NOT NULL)),
    FOREIGN KEY (school_id, student_id) REFERENCES students (school_id, id),
    FOREIGN KEY (school_id, academic_year_id) REFERENCES academic_years (school_id, id),
    FOREIGN KEY (school_id, reverses_receipt_id) REFERENCES fee_receipts (school_id, id),
    FOREIGN KEY (school_id, recorded_by_membership_id) REFERENCES school_memberships (school_id, id)
);

CREATE INDEX fee_receipts_student_idx ON fee_receipts (school_id, student_id, academic_year_id);

CREATE INDEX fee_receipts_received_idx ON fee_receipts (school_id, received_on);

CREATE INDEX fee_receipts_reverses_idx ON fee_receipts (school_id, reverses_receipt_id)
WHERE
    reverses_receipt_id IS NOT NULL;

-- A payment can be cancelled once. Refunds may be several, so they are bounded
-- by the API against what is left of the payment.
CREATE UNIQUE INDEX fee_receipts_one_cancellation ON fee_receipts (school_id, reverses_receipt_id)
WHERE
    kind = 'cancellation';

-- The amount of one ledger row, split by fee head. The lines of a row always
-- add up to its amount; the API writes them in the same transaction.
CREATE TABLE fee_receipt_lines (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    school_id uuid NOT NULL REFERENCES schools (id) ON DELETE RESTRICT,
    receipt_id uuid NOT NULL,
    fee_head_id uuid NOT NULL,
    amount_paise bigint NOT NULL CHECK (amount_paise > 0 AND amount_paise <= 100000000000),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (school_id, id),
    UNIQUE (school_id, receipt_id, fee_head_id),
    FOREIGN KEY (school_id, receipt_id) REFERENCES fee_receipts (school_id, id),
    FOREIGN KEY (school_id, fee_head_id) REFERENCES fee_heads (school_id, id)
);

-- The ledger is append-only in the database, not only in the API. A DELETE is
-- always refused. An UPDATE is refused unless the only thing it does is clear
-- payer_name, which is what anonymising a pupil needs: the money row stays
-- exactly as it was written, and the name of whoever paid goes.
CREATE FUNCTION fee_receipts_immutable ()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.payer_name IS NULL AND (to_jsonb (NEW) - 'payer_name') = (to_jsonb (OLD) - 'payer_name') THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'fee receipts are append-only';
END
$$;

CREATE TRIGGER fee_receipts_no_change
    BEFORE UPDATE OR DELETE ON fee_receipts
    FOR EACH ROW
    EXECUTE FUNCTION fee_receipts_immutable ();

CREATE FUNCTION fee_receipt_lines_immutable ()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'fee receipt lines are append-only';
END
$$;

CREATE TRIGGER fee_receipt_lines_no_change
    BEFORE UPDATE OR DELETE ON fee_receipt_lines
    FOR EACH ROW
    EXECUTE FUNCTION fee_receipt_lines_immutable ();

DO $$
DECLARE
    table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY['fee_heads', 'fee_structures', 'fee_student_heads', 'fee_concessions', 'fee_receipts', 'fee_receipt_lines']
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
        EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (school_id = NULLIF(current_setting(''app.school_id'', true), '''')::uuid) WITH CHECK (school_id = NULLIF(current_setting(''app.school_id'', true), '''')::uuid)', table_name);
    END LOOP;
END
$$;

REVOKE ALL ON fee_heads, fee_structures, fee_student_heads, fee_concessions, fee_receipts, fee_receipt_lines FROM PUBLIC;

-- What the school charges can be edited and, while nothing depends on it,
-- removed. The API refuses a removal that a payment still stands on.
GRANT SELECT, INSERT, UPDATE, DELETE ON fee_heads, fee_structures, fee_student_heads, fee_concessions TO erp_runtime;

-- The ledger: read and append. The single column the runtime login may update
-- is payer_name, and the trigger above lets it do one thing with it.
GRANT SELECT, INSERT ON fee_receipts, fee_receipt_lines TO erp_runtime;

GRANT UPDATE (payer_name) ON fee_receipts TO erp_runtime;

-- Receipt numbers come from the same counters as admission numbers: one row
-- per school, kind and academic year.
ALTER TABLE number_sequences
    DROP CONSTRAINT number_sequences_kind_check;

ALTER TABLE number_sequences
    ADD CONSTRAINT number_sequences_kind_check CHECK (kind IN ('admission', 'employee', 'receipt'));

-- Three new kinds of export file: one receipt as a document, and the dues list
-- and the collection register as a spreadsheet or a document.
ALTER TABLE export_jobs
    DROP CONSTRAINT export_jobs_kind_check;

ALTER TABLE export_jobs
    ADD CONSTRAINT export_jobs_kind_check CHECK (kind IN ('students', 'staff', 'audit', 'student_profile', 'staff_profile', 'timetable', 'fee_receipt', 'fee_dues', 'fee_collections'));
