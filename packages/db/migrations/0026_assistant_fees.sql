-- Fee changes through the assistant (Task 24d). See
-- docs/assistant/ARCHITECTURE.md section 5.
--
-- Three proposal kinds: a payment, a concession and an optional fee, each
-- one call to the fees module's own write route.
--
-- A done payment links to the receipt it made, which does not exist until
-- the write. The preview column never changes after a proposal is made, so
-- the link goes in a column of its own: an app path, which names a record by
-- its id and nobody by name.
--
-- Additive: the release before this one never writes these kinds or reads
-- the column.

ALTER TABLE assistant_proposals
    DROP CONSTRAINT assistant_proposals_kind_check;

ALTER TABLE assistant_proposals
    ADD CONSTRAINT assistant_proposals_kind_check CHECK (kind IN ('attendance_day', 'staff_attendance_day', 'exam_marks', 'co_scholastic', 'message', 'message_withdraw', 'fee_payment', 'fee_concession', 'fee_opt_in'));

ALTER TABLE assistant_proposals
    ADD COLUMN written_href text CHECK (written_href IS NULL OR (length(written_href) <= 300 AND written_href LIKE '/%'));

GRANT UPDATE (written_href) ON assistant_proposals TO erp_runtime;
