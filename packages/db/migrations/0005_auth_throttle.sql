-- Authentication throttling that the provider does not own.
--
-- Better Auth prunes its own rate-limit table on the longest configured window
-- (60 seconds here), so any budget that has to survive longer than that cannot
-- live in auth_rate_limit. The OTP daily budgets and the step-up attempt
-- counters live here instead, each row carrying its own expiry.
CREATE TABLE auth_throttle (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    key text NOT NULL UNIQUE,
    count integer NOT NULL DEFAULT 0,
    last_request bigint NOT NULL DEFAULT 0,
    expires_at timestamptz NOT NULL
);

CREATE INDEX auth_throttle_expires_idx ON auth_throttle (expires_at);

-- Global auth infrastructure table: no school_id, therefore no tenant RLS.
REVOKE ALL ON auth_throttle FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON auth_throttle TO erp_auth;

-- A shared front-desk browser gets a shorter session than a personal device.
ALTER TABLE auth_session
    ADD COLUMN shared_device boolean NOT NULL DEFAULT FALSE;
