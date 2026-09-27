-- Messages and notices through the assistant (Task 24c). See
-- docs/assistant/ARCHITECTURE.md section 5.
--
-- Two proposal kinds: a notice (a new one, or a change to one of the
-- person's own drafts or scheduled messages) and taking back a sent one.
--
-- Additive: the release before this one never writes either kind.

ALTER TABLE assistant_proposals
    DROP CONSTRAINT assistant_proposals_kind_check;

ALTER TABLE assistant_proposals
    ADD CONSTRAINT assistant_proposals_kind_check CHECK (kind IN ('attendance_day', 'staff_attendance_day', 'exam_marks', 'co_scholastic', 'message', 'message_withdraw'));
