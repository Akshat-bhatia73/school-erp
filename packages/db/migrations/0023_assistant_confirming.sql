-- Proposals, confirmed in three short steps (Task 24 hardening). See
-- docs/assistant/ARCHITECTURE.md section 5.
--
-- Until now Confirm held the proposal's row lock while the real write route
-- ran in a transaction of its own, and marked the proposal done only after
-- that write had committed. A crash in between left a written change on an
-- open proposal. Now Confirm first marks the proposal 'confirming' with the
-- request id the write will carry, commits, sends the write, and then settles
-- the proposal. A proposal left 'confirming' is settled later from the
-- write's own audit row: found means done, missing means nothing was written.
--
-- Additive: one status, one column, and the pairing of status and decided_at
-- widened to allow it. The release before this one never writes the status.

ALTER TABLE assistant_proposals
    ADD COLUMN confirming_at timestamptz;

ALTER TABLE assistant_proposals
    DROP CONSTRAINT assistant_proposals_status_check;

ALTER TABLE assistant_proposals
    ADD CONSTRAINT assistant_proposals_status_check CHECK (status IN ('open', 'confirming', 'done', 'dismissed', 'expired', 'stale', 'failed'));

-- Open and confirming are undecided; everything else but expired is decided.
ALTER TABLE assistant_proposals
    DROP CONSTRAINT assistant_proposals_check;

ALTER TABLE assistant_proposals
    ADD CONSTRAINT assistant_proposals_check CHECK ((status IN ('open', 'confirming')) = (decided_at IS NULL) OR status = 'expired');

-- A confirming proposal always names the write it is waiting for.
ALTER TABLE assistant_proposals
    ADD CONSTRAINT assistant_proposals_confirming_check CHECK (status <> 'confirming' OR (confirming_at IS NOT NULL AND write_request_id IS NOT NULL));

GRANT UPDATE (confirming_at) ON assistant_proposals TO erp_runtime;

-- Finding the write's audit row by its request id, for the few proposals a
-- crash leaves confirming.
CREATE INDEX audit_events_request_idx ON audit_events (school_id, request_id);
