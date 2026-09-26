-- The assistant's turns (Task 24 hardening). See docs/assistant/ARCHITECTURE.md
-- sections 9, 10 and 14.
--
-- Two small columns. `failed_calls` counts the lookups of a question that
-- failed, beside the calls made and refused, so a question answered around a
-- failed lookup can be told from one answered in full. `answering_until` is a
-- short lease on a conversation while an answer is being written in it, so a
-- second tab cannot start another answer in the same conversation at once; a
-- turn clears it when it ends, and it runs out on its own after five minutes
-- if the turn never could.
--
-- Additive: the release before this one never reads either column, and both
-- have a value an older row is right to hold.

ALTER TABLE assistant_usage
    ADD COLUMN failed_calls integer NOT NULL DEFAULT 0 CHECK (failed_calls >= 0);

GRANT UPDATE (failed_calls) ON assistant_usage TO erp_runtime;

ALTER TABLE assistant_threads
    ADD COLUMN answering_until timestamptz;

GRANT UPDATE (answering_until) ON assistant_threads TO erp_runtime;
