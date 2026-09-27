-- A choice of second step: an authenticator app, a code by text message or
-- a code by email. See docs/auth/AUTHENTICATION.md, "Assurance, MFA and
-- fresh authentication".
--
-- two_factor_method is the step the person has proven and uses now. It is
-- the only one a sign-in challenge accepts (a backup code always works).
-- two_factor_pending_method is a step the person asked to switch to; it
-- becomes the method only when a code from it is accepted on their own
-- session, so an abandoned switch leaves the old step in place.
--
-- Everyone who has a second step today has an authenticator app.
--
-- Additive: the release before this one never reads these columns.

ALTER TABLE auth_user
    ADD COLUMN two_factor_method text CHECK (two_factor_method IN ('totp', 'sms', 'email')),
    ADD COLUMN two_factor_pending_method text CHECK (two_factor_pending_method IN ('totp', 'sms', 'email'));

UPDATE
    auth_user
SET
    two_factor_method = 'totp'
WHERE
    two_factor_enabled;

-- A session opened with a code sent to the phone cannot use a code sent to
-- the same phone as its second step: that would be one factor twice.
ALTER TABLE auth_session
    ADD COLUMN phone_code_sign_in boolean NOT NULL DEFAULT FALSE;

-- An email second-step code is held for a tester in a test build, as a text
-- message is, because the seeded addresses cannot receive mail.
ALTER TABLE held_sms
    DROP CONSTRAINT held_sms_purpose_check;

ALTER TABLE held_sms
    ADD CONSTRAINT held_sms_purpose_check CHECK (purpose IN ('otp', 'password_reset', 'verification', 'invitation', 'student_password', 'second_factor'));
