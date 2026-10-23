-- A shared test account that signs in without a second step.
--
-- Decided by the product owner on 23 October 2026: an outside tester needs an
-- office admin login on the hosted test site without an authenticator. An
-- operator sets this flag by hand on a dummy identity; no route, invitation or
-- provider call can set it. A session of a flagged identity counts as verified
-- from the moment it signed in, so the MFA gate and the five-minute freshness
-- check treat it like a session that answered a challenge at sign-in.
--
-- Never set it on a real person's identity.
ALTER TABLE auth_user
    ADD COLUMN mfa_exempt boolean NOT NULL DEFAULT FALSE;
