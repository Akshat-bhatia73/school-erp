-- Text messages a test environment holds instead of sending.
--
-- There is no SMS provider yet (Indian transactional SMS needs DLT
-- registration), so a hosted test build keeps a parent's one-time code here
-- for a few minutes and a tester holding HELD_SMS_TOKEN reads it. A function
-- host has no shared memory, which is why this is a table and not a list. The
-- API writes rows only when that token is configured; a real school never is.
CREATE TABLE held_sms (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    recipient text NOT NULL,
    purpose text NOT NULL CHECK (purpose IN ('otp', 'password_reset', 'verification', 'invitation')),
    secret text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
);

CREATE INDEX held_sms_expires_idx ON held_sms (expires_at);

-- Global auth infrastructure table: no school_id, therefore no tenant RLS.
REVOKE ALL ON held_sms FROM PUBLIC;

GRANT SELECT, INSERT, DELETE ON held_sms TO erp_auth;
