# Data protection assessment

An honest account, as of 17 September 2026, of which laws and standards apply to this system, what personal data it holds, how well that data is protected today, and what must change before a real school's children are in it.

This is an engineering assessment, not legal advice. The Digital Personal Data Protection Rules were notified in November 2025 with a phased commencement, and the details of exemptions and timelines should be confirmed with counsel before a school signs a contract.

Companion documents: [release runbook](../auth/RELEASE.md), [access review](../auth/ACCESS_REVIEW.md), [authentication](../auth/AUTHENTICATION.md), [authorization](../auth/AUTHORIZATION.md), [database](../auth/DATABASE.md).

## 1. Summary

The access-control core is strong and unusually well evidenced: forced row-level security on every school table, a transaction-local tenant context, a permission gate on every route, per-record projections, append-only audit rows and an adversarial test suite that runs against real PostgreSQL. Nothing in this assessment found a way for one school or one role to read data it should not.

The gaps are in the **data lifecycle**, not in access control. The system has no way to record consent, no way to delete or anonymise a person, no sweeper for tables that accumulate children's data and credentials, no record of who *read* a child's record, and no breach-response procedure. A free-text "reason" field flows unfiltered into permanent audit rows. One government identifier for children (APAAR) is stored in full where every other identifier is truncated.

None of these gaps leak data today. All of them would be findings in a DPDP audit, and several would make a breach worse than it needs to be. Section 6 turns them into three tasks.

The assessment itself is left as it was written. What has changed since is marked in the finding tables: Task 12 closed F1, F2, F3, F4, F5, F9, F13, F14 and F15 on 18 September 2026, and each of those rows names the file that closes it. Task 13 closed F6, F7, F8, F10, F11, F12 on 19 September 2026 and decided F19 apart from its region. Task 14 closed F17 and F18 on 19 September 2026, closed F16 apart from repository visibility, and took the region decision that F19 was waiting for. The retention schedule in section 7 is now adopted rather than proposed.

Two things are worth reading as they are written rather than as a tick. Task 14 delivered a backup **procedure** that has been tested locally and a weekly dump that is **not scheduled**, because there is no Indian bucket and no key holder yet; and the four school-facing documents are templates with commercial terms left as placeholders, not signed contracts. Documented is not the same as evidenced, and section 8 says so per row.

## 2. What applies

### 2.1 Digital Personal Data Protection Act, 2023 and Rules, 2025

The Act is India's data protection law. The Rules were notified in November 2025 and commence in phases: the Data Protection Board immediately, consent-manager registration after twelve months, and the substantive obligations on fiduciaries after eighteen months, so around May 2027. A school going live before then is still under the IT Act regime below, but building for the DPDP Act now is the only sensible course.

**Roles.** The school is the **data fiduciary**: it decides why and how a child's data is processed. This company, running the platform on the school's behalf, is a **data processor**. That matters in two ways. The school carries the legal duties (notice, consent, rights, breach notification to the Board), but it can only meet them if the platform gives it the means, and the Rules require the fiduciary to bind its processors by contract to reasonable security safeguards. For the shared login identity that spans schools (`auth_user` and its sessions), and for any analytics or product telemetry, this company is itself a fiduciary.

**Obligations the platform must make possible.**

| Requirement | Where it comes from | What the platform must provide |
|---|---|---|
| Notice and consent, in plain language, for each purpose | Sections 5 and 6 | A place to record that consent was given, by whom, for what, when, and that it can be withdrawn |
| Verifiable parental consent before processing a child's data | Section 9 and Rule 10 | The same record, with the guardian identified and the verification method noted. See the exemption note below |
| No tracking, behavioural monitoring or targeted advertising of children | Section 9(3) | Nothing of the kind exists today; keep it that way and say so in the notice |
| Purpose limitation and data minimisation | Section 4 and 6 | Collect only what the school needs; do not store fields no screen uses |
| Accuracy and the right to correction | Sections 8 and 12 | Edit paths exist for most fields |
| Erasure when the purpose is served or consent is withdrawn | Section 8(7) and 12 | A deletion or anonymisation path per data subject, and sweepers for transient tables |
| Right of access | Section 11 | A way to assemble everything held about one student or guardian |
| Reasonable security safeguards | Section 8(5) and Rule 6 | Encryption or masking, access control, logs and monitoring able to detect unauthorised access, retention of those logs and the related data for one year, backups, and processor contracts |
| Breach notification | Section 8(6) and Rule 7 | Tell affected persons without delay; tell the Board without delay and file a full report within 72 hours. The platform must be able to say what was accessed and whose |
| Grievance redressal and a named contact | Sections 10 and 13 | A published contact and response time in the notice |

**Children and the education exemption.** The Rules' Fourth Schedule exempts educational institutions from the verifiable-consent and tracking restrictions to the extent processing is necessary for educational activities, the child's safety, and transport tracking. Read narrowly, a school does not need a fresh parental consent to keep an admission register. Read honestly, that exemption does not obviously cover photographs, health notes beyond immediate safety, caste category, guardian income, or sharing with third-party services. The safe design is to record parental consent at admission anyway, per purpose, and to rely on the exemption only as a fallback. It is cheap to do and expensive to retrofit.

**Cross-border transfer.** The Act allows transfer to any country the central government has not restricted. No restriction had been notified at the time of writing. Even so, the hosting decision in the runbook should pin an Indian region where the provider offers one, and the sub-processor list should state the region of each.

### 2.2 Information Technology Act, 2000 and the SPDI Rules, 2011

Until the DPDP sections commence, section 43A and the Sensitive Personal Data or Information Rules are the law in force. They define sensitive data as passwords, financial information, health condition, medical records, sexual orientation and biometrics; require a privacy policy, consent for collecting sensitive data, no retention beyond need, and "reasonable security practices", for which ISO 27001 is the named example. Everything in section 2.1 satisfies this regime too.

### 2.3 CERT-In directions of April 2022

These apply to every service provider and body corporate in India and are often forgotten. Three obligations bite here: report a cyber security incident to CERT-In within **six hours** of noticing it; keep system logs for **180 days within India**; synchronise clocks to NTP. The runbook's alerting section and the incident plan proposed below must carry the six-hour clock, and log retention must be a deliberate choice of provider and region, not a default.

### 2.4 Identifiers with their own rules

- **Aadhaar.** The Aadhaar Act and UIDAI circulars restrict storing Aadhaar numbers. Since the office feedback work (September 2026) the whole number may be kept, because a school has to quote it for scholarships and board registrations, but only under the conditions in section 10: it is optional, it is encrypted with the application key, no screen or file shows more than the last four digits, and the only way to the whole number is one audited route behind the sensitive key. A plain-text Aadhaar column is still forbidden.
- **APAAR.** The Automated Permanent Academic Account Registry number is a lifelong identifier for a child issued through DigiLocker. It is not regulated like Aadhaar, but it is a persistent child identifier that unlocks academic records elsewhere. The schema stores it in full and returns it in full. Treat it like Aadhaar: masked by default, revealed only under the sensitive read, encrypted at rest at the application level.
- **PAN and bank account.** A staff PAN and bank account are still last four digits only. A guardian's PAN, added in September 2026, is optional and is held the same way as the Aadhaar number above: encrypted, shown as its last four characters, revealed only through an audited route. Salary and guardian income are stored in full and are behind their own permissions.

### 2.5 SOC 2 and ISO 27001

SOC 2 is not a law and not something a system "complies with". It is an audit report, against the AICPA Trust Services Criteria, that an independent CPA firm issues about an organisation's controls: Type I on a date, Type II over a period of six to twelve months. Security is the mandatory criterion; Availability, Confidentiality, Processing Integrity and Privacy are optional. The audit costs money, typically several thousand dollars at the low end, plus the tooling to collect evidence, and it examines the organisation as much as the code: policies, onboarding and offboarding, vendor reviews, risk assessments, incident records.

For an MVP with no revenue, the right goal is **SOC 2-aligned controls with evidence kept from day one**, so that a Type I report is a matter of paying for the audit rather than rebuilding. Indian schools are unlikely to ask for SOC 2; they are likely to ask for a DPDP posture, a privacy notice and a signed processing agreement. ISO 27001 is the standard Indian buyers recognise more readily and is named in the SPDI Rules; its control set overlaps SOC 2 heavily. Section 5 maps the common criteria to what exists.

### 2.6 What does not apply

GDPR applies only if the platform offers services to people in the EU or monitors them. COPPA and FERPA are United States laws. None of them binds an Indian school with Indian pupils. Their design principles (parental consent, purpose limitation, access rights) are the same ones the DPDP Act adopts, so following the DPDP path covers them in spirit.

## 3. What the system holds

The full column-level inventory was produced by reading every migration, contract and projection. The condensed view:

| Data subject | Identifiers and contact | Sensitive | Credentials and behaviour |
|---|---|---|---|
| **Student (a child)** | name, admission number, roll number, address, admission history, previous school | date of birth, gender, blood group, caste category, religion, mother tongue, nationality, Aadhaar last four, **APAAR in full**, medical notes (free text), reason for leaving (free text), document types (a caste certificate is itself sensitive), **the whole Aadhaar number, encrypted**, a photograph in the private document store, custody and guardian-access links | none: student login is disabled by design |
| **Guardian** | name, phone, alternate phone, email, address | occupation, qualification, **annual income**, relation to the child, office address, **PAN and Aadhaar number, both encrypted** | login identity below, if they have one |
| **Staff** | employee code, name, phone, email, address, designation, employment dates | gender, date of birth, blood group, **monthly salary**, PAN last four, bank account last four, a photograph in the private document store, absence and substitution records with free-text reasons | login identity below |
| **Login identity** (any adult) | name, email, phone | | password hash (scrypt, library default), TOTP secret and backup codes (stored as the library writes them), session tokens in clear, IP address and user agent per session, OTP and reset tokens in `auth_verification`, throttle keys that contain raw phone numbers and one raw IP |

Three tables hold copies of the above outside their home rows and have no sweeper: `student_import_previews.rows` (a full copy of an uploaded admission sheet, up to 500 children with guardian phone and email), `school_invitations.identifier_normalized` (the invitee's raw email or phone, kept after acceptance), and `audit_events.safe_changes` (which carries whatever an office user typed into a "reason" box).

Where it flows: API responses are projected per permission and never spread a storage row; audit summaries are static sentences; delivery messages carry the real address and the raw code but are held in memory by the sandbox and never sent; the outbox stores a masked destination and no token; search matches names and codes only; no export file is ever produced today; the server writes no per-request log line; the browser keeps only a school id, a theme and a sidebar state, with query results in memory for the life of the tab.

## 4. What is already right

Stated positively because it is evidenced, not assumed.

- **Tenant isolation is enforced in the database.** Row-level security is enabled and forced on every school table with a `school_id = current_setting('app.school_id')` policy in both directions. The tenant helper sets that value transaction-locally and refuses to run on any connection that is not the least-privileged runtime role. A pooled connection cannot carry one school into the next request. Proved by `packages/db/tests` and by the anonymous sweep in `tests/security`, which reads the live route table so it cannot go stale.
- **Every route has a declared permission, or it cannot be registered.** The gate decides against the school before the handler, lists are narrowed by the same predicate a single read would use, and every response is parsed through its contract so a projection bug becomes a 503 rather than a leak.
- **Four database logins with one job each.** The migrator is refused at production startup; the runtime cannot read auth tables; the auth login cannot read school tables; the identity login can only execute two functions.
- **Audit rows are append-only twice over**: the runtime holds `SELECT, INSERT` only, and a trigger refuses `UPDATE` and `DELETE` even from the owner. Actor and request id come from the verified context, never from the body, and the row commits with the change or not at all.
- **Privileged roles must complete a second factor**, the trust-device shortcut is stripped on both legs, sessions have absolute and idle limits per role, password change and reset revoke other sessions, and replacing or removing the authenticator now clears every earlier MFA stamp.
- **Logs are quiet by design.** No request line is written; the error handler logs a request id and an error code; cookies, tokens, codes and passwords are on the redaction list; provider messages never reach a log or a response.
- **Invitation tokens are never stored**, only their SHA-256 digest, and resend replaces the digest.
- **Production refuses unsafe configuration** at startup: the example secret, a short secret, plain HTTP, sandbox delivery without an explicit override, the migrator login.

## 5. Findings

Ranked by what would matter most in a breach or an audit. Each has a file to touch.

### 5.1 Blocking before any real school

| # | Finding | Why it matters | Remedy |
|---|---|---|---|
| F1 | **No consent record.** Nothing records that a parent agreed to anything, for what purpose, or that they can withdraw. | The single most visible DPDP requirement for children's data, and the one auditors check first. The education exemption is narrow. | A `guardian_consents` table (guardian, student, purpose, given or withdrawn, method of verification, timestamps, evidence reference) under tenant RLS with append-only history; a contract; a capture step in admission and on the parent's own screen. `packages/db/migrations`, `packages/contracts`, `apps/api/src/modules/students`. **Closed** by `packages/db/migrations/0009_data_lifecycle.sql` (`guardian_consents`, append-only), `packages/contracts/src/module-lifecycle.ts`, `apps/api/src/modules/students/consents.ts`, the admission consent step and the profile and parent-home panels in `apps/web`. |
| F2 | **No deletion or anonymisation of any person.** A student who leaves keeps name, birth date, Aadhaar fragment, APAAR, medical notes and address forever. Guardians cannot be unlinked or removed. Staff keep salary and identifier fragments after leaving. A removed member keeps their password hash, TOTP secret, backup codes and live sessions. | Erasure is a right under the Act and a duty once the purpose is served. State education rules require admission registers to be kept, so the answer is anonymisation of the sensitive fields on a schedule, not deletion of the register row. | A retention policy per data class (section 7), an `anonymise student` workflow that clears sensitive columns and documents after the retention period while keeping the register fields, guardian unlink and delete, staff anonymisation after leaving, and membership removal that revokes sessions and, when the identity has no other school, deletes the credential rows. **Closed** by `apps/api/src/modules/students/lifecycle.ts` (student anonymisation and guardian unlink), `apps/api/src/modules/staff/lifecycle.ts`, `apps/api/src/memberships/lifecycle.ts` (sessions ended on removal) and `sweep_orphaned_credentials` in the migration. The retention schedule is section 7. |
| F3 | **Free text flows into permanent audit rows.** Every "reason" field (pay change, assignment, move, leaving, role change, suspension, recovery, ownership) is written verbatim into `audit_events.safe_changes`, which can never be edited or deleted. | The audit contract promises "no names, addresses, phone numbers"; the reason box breaks it. "Raised Priya's salary to 85000 after her diabetes leave" becomes a permanent, unerasable record readable by anyone with database access and by a future export. | Store the reason in a separate `audit_event_notes` table without the append-only trigger, readable only under `audit.read` at school scope, so it can be redacted on request; keep `safe_changes` structural. Nine call sites in `apps/api/src/modules/staff/writes.ts`, `students/writes.ts`, `memberships/*.ts`. **Closed** by `audit_event_notes` in the migration, the optional `note` on `apps/api/src/memberships/audit.ts` and `apps/api/src/modules/shared/audit.ts`, the nine call sites that now pass it, and the redaction route in `apps/api/src/modules/audit/routes.ts`. |
| F4 | **APAAR stored and returned in full.** Every other identifier is truncated to four digits. | A lifelong child identifier that opens academic records elsewhere. | Encrypt at the application level with a key from the secret store (pgcrypto or Node's `crypto` with AES-GCM), return masked (`XXXX-XXXX-1234`) by default, reveal in full only under `students.read_sensitive` and audit the reveal. `packages/contracts/src/responses.ts`, `apps/api/src/modules/students/project.ts`. **Closed** by `apps/api/src/modules/shared/crypto.ts` (AES-256-GCM under `DATA_ENCRYPTION_KEY`), `apaar_ciphertext`/`apaar_last4` in the migration, `apaarMasked` in `packages/contracts/src/responses.ts`, and the audited reveal route in `apps/api/src/modules/students/routes.ts`. |
| F5 | **Unswept copies of children's data.** `student_import_previews.rows` keeps every uploaded admission sheet indefinitely; `auth_verification` keeps used OTPs and reset tokens; `auth_session` rows for abandoned sessions keep IP and user agent forever; `school_invitations` keeps the raw email or phone after acceptance; `auth_throttle` keeps raw phone numbers and an IP with no expiry; `delivery_outbox` is never purged. | Every one is a shadow copy that a breach would expose and that a retention policy cannot account for. | One scheduled sweeper (a Vercel cron route or a GitHub Actions cron calling a protected maintenance endpoint) that deletes expired previews, verifications, sessions, throttle rows and old outbox rows, and blanks the invitation identifier once the row is terminal. Hash the phone in throttle keys as the MFA code already hashes the IP. `apps/api/src/auth/phone-otp.ts`, new `apps/api/src/maintenance`. **Closed** by the three `SECURITY DEFINER` sweep functions in the migration, `apps/api/src/maintenance/routes.ts`, the daily cron in `vercel.json`, and `hashPhone` in `apps/api/src/auth/phone-otp.ts`. |
| F6 | **No record of who read a child's record.** Only writes and bulk exports leave an audit row. | "Who looked at this child's file" is the first question after a complaint and the platform cannot answer it. The DPDP Rules require logs able to detect unauthorised access. | An `auditRead` flag on the route definition that writes an `allowed` row for detail reads of students, guardians, staff private and pay blocks, and documents, inside the handler's transaction. `apps/api/src/modules/shared/route.ts`. **Closed** by `auditRead` on `RouteDefinition` in `apps/api/src/modules/shared/route.ts`, which writes one `allowed` row after the response is validated, applied to student detail, student guardians, student consents, staff detail, the APAAR reveal and the subject-access export. |
| F7 | **Denials are not recorded and barely logged.** A refusal at the gate throws before any row; the log line carries a request id and a code but no actor, route or address. | The runbook's alert can detect a burst but cannot say who probed what. Breach reporting needs that. | One structured line per request from an `onResponse` hook (method, route, status, code, user id, membership id, school id, hashed IP, duration) and a `denied` audit row for gate refusals written on a separate connection so the rollback does not swallow it. `apps/api/src/app.ts`, `apps/api/src/modules/shared/route.ts`. **Closed** by the `denied` audit row and the twenty-in-ten-minutes burst report in `apps/api/src/modules/shared/route.ts`, `reportDenialBurst` in `apps/api/src/observability.ts`, and the one-row-per-request access log in `apps/api/src/http/access-log.ts` (`access_log` in `packages/db/migrations/0010_observability.sql`). |
| F8 | **No breach-response procedure.** No severity levels, no named roles, no notification timeline, no alert sink configured. | The DPDP Rules want the Board told within 72 hours with a full report; CERT-In wants notice within six hours. Nobody can meet either clock without a plan. | `docs/compliance/INCIDENT_RESPONSE.md` with the two clocks, containment steps (rotate `AUTH_SECRET`, revoke sessions, suspend memberships), evidence collection, and a named owner; wire the error handler and the denial threshold to Sentry. **Closed** by `docs/compliance/INCIDENT_RESPONSE.md` and the Sentry burst event above. |

### 5.2 Important, fix in the same pass

| # | Finding | Remedy |
|---|---|---|
| F9 | **Roster query over-fetches.** The student list selects date of birth, Aadhaar fragment, APAAR, blood group, medical notes and address for every row even for a caller who holds only `students.read_basic`; the projection drops them before the response. One bug away from disclosure of a hundred children's medical notes. | Select the sensitive columns only when the plan grants the matching field group. `apps/api/src/modules/students/reads.ts`. **Closed** by `studentProjection({ sensitive, medical })` in `apps/api/src/modules/students/reads.ts`: the roster, the count and the search build the statement with both false, and only the detail route asks for more, after deciding the two keys. |
| F10 | **No account lockout and no way to disable an identity.** Rate limits are per address, so a distributed password spray has no per-account ceiling; there is no `auth_user.disabled_at`. | A durable per-user failure counter with a temporary lock, and a `disabled_at` column checked when a session is resolved. `apps/api/src/auth/throttle.ts`, `session.ts`, a migration. **Closed** by `apps/api/src/auth/lockout.ts` (ten failed password sign-ins lock the identity for fifteen minutes), the hooks in `apps/api/src/auth/better-auth.ts`, the `disabled_at` check in `apps/api/src/auth/session.ts`, the `auth_user` columns in the migration, and `apps/api/scripts/disable-identity.ts`. |
| F11 | **Dev credentials file is world-readable.** `apps/api/.dev/sunrise-logins.csv` holds plaintext passwords and TOTP seeds at mode 0644. | Write with mode 0600 and create the directory with 0700. `apps/api/scripts/dev-seed.ts`. Also: `chmod 600` the file that exists now. **Closed**: `apps/api/scripts/dev-seed.ts` creates `.dev` with mode `0700` and writes the logins file with mode `0600`, and chmods both when they already exist. |
| F12 | **No subject-access export.** A parent asking for everything held about their child cannot be served without direct database access, which the runbook forbids. | A `subject.export` permission and a route that assembles one student's full record through the existing read plans, audited. **Closed** by the `students.export_subject` permission, `SubjectAccessExport` in `packages/contracts/src/module-lifecycle.ts` and `apps/api/src/modules/students/subject-access.ts`; the export is audited through `auditRead`. |
| F13 | **The runtime login can `DELETE` from every child table.** Application code never does, but nothing in SQL stops it. | Revoke `DELETE` on `students`, `guardians`, `staff`, `student_documents` and `audit_events` from the runtime; make removal a status change plus the anonymisation workflow above. A migration. **Closed** by the `REVOKE DELETE` in `packages/db/migrations/0009_data_lifecycle.sql`, with a test in `packages/db/tests/lifecycle.test.mjs`. |
| F14 | **Dormant photo columns.** `photo_url` exists on students, guardians and staff with no upload path, no projection and no access rule. | Drop the columns until a photo feature exists with its own permission and consent purpose. **Closed**: the three `photo_url` columns are dropped in `packages/db/migrations/0009_data_lifecycle.sql`. |
| F15 | **A student export claims to be ready with nothing behind it.** Harmless while no download existed; a hole the moment one was added. | Insert `queued` like the other two exports. `apps/api/src/modules/students-bulk/routes.ts`. **Closed**: the job is inserted as `queued` in `apps/api/src/modules/students-bulk/routes.ts`. Task 15 added the download, so a job only reports `ready` once its bytes are stored, and the download route re-decides the caller, the access version and, for a job naming one record, that record itself (`apps/api/src/modules/files/routes.ts`). |

### 5.3 Governance and repository

| # | Finding | Remedy |
|---|---|---|
| F16 | **The repository is public** and holds the complete data model for children's records plus development credentials. Nothing secret is in it, but it maps the target for anyone. No branch protection, no CODEOWNERS, no secret scanning, no Dependabot; the advisory step in CI does not gate. | Make the repository private; add a ruleset on `main` requiring the CI checks and one review; add `CODEOWNERS`, Dependabot and secret scanning; remove `continue-on-error` from the advisory step with a documented exceptions file. **Closed except visibility** on 19 September 2026: `.github/CODEOWNERS` (maintainer everywhere, with `packages/db/migrations`, `packages/authz`, `packages/contracts/src/permissions.ts`, `docs/compliance`, `.github`, `SECURITY.md` and `.audit-exceptions.json` called out), `.github/dependabot.yml` (npm weekly with minor and patch grouped and security updates left ungrouped, plus GitHub Actions), `SECURITY.md`, the `static` CI job split into the separate `typecheck`, `lint` and `contracts` checks, and an advisory gate that now fails the build: `scripts/audit-deps.mjs` blocks any high or critical advisory that is not listed in `.audit-exceptions.json`, fails on an exception whose `until` date has passed, and prints what it accepted. The exceptions file is empty today; `pnpm audit` on 19 September 2026 reported one moderate advisory (`GHSA-67mh-4wv8-2f99` in `esbuild`, reached through `drizzle-kit`) and no high or critical. Applied in GitHub settings the same day, not in code: a "Protect main" ruleset (pull request required, checks required and up to date, no force push, no deletion, threads resolved, zero approvals because one person maintains the repository), secret scanning with push protection, Dependabot alerts and security updates. **Open: the repository is still public.** On GitHub Free, rulesets, code owners and secret scanning are enforced only on public repositories, so going private on this plan would remove all three. The fix is a paid plan: GitHub Team is $4 per user per month and lists repository rules, code owners and GitHub Secret Protection for private repositories ([github.com/pricing](https://github.com/pricing), read 19 September 2026). Vercel Hobby deploys from private repositories, so nothing else blocks the switch. |
| F17 | **Backups are prose.** No backup job exists, and the plan to keep a `pg_dump` as a GitHub Actions artifact would put a full copy of children's records in a third-party artifact store with 90-day default retention. | Dump to an encrypted, access-controlled bucket in an Indian region, or rely on the database provider's own snapshots and rehearse a restore quarterly. Never an Actions artifact. **Closed as a procedure, not as a running job**, by [`docs/auth/BACKUPS.md`](../auth/BACKUPS.md): what Neon keeps (six hours of history on the Free plan, one day up to seven on Launch, up to thirty on Scale, checked against Neon's documentation on 19 September 2026), how to restore to a point in time as a branch, `scripts/backup-dump.sh` (`pg_dump` with the migrator login, encrypted with `age`, uploaded to an `ap-south-1` bucket, never an Actions artifact), the quarterly rehearsal, and what to do when the primary is lost. `scripts/restore-rehearsal.mjs` checks every migration is applied, that every tenant table has RLS forced, that the four logins exist, and prints row counts; it was run against a local restored database on 19 September 2026 and passed, and its failure path was tested. [`docs/compliance/RESTORE_LOG.md`](RESTORE_LOG.md) holds the template and one entry saying no rehearsal has been performed. `RELEASE.md` section 5 is now a pointer and checklist item 9 requires a passed entry in that log. **Still open:** the weekly dump is not scheduled and there is no bucket, no `age` key and no key holder; no restore has been rehearsed against production; Vercel Blob documents are not backed up at all; and there is no escrow for `DATA_ENCRYPTION_KEY`, so losing the Vercel account would make every sealed APAAR field unreadable (BACKUPS.md section 7). |
| F18 | **No processor agreement, sub-processor list, privacy notice or region statement.** A school cannot lawfully use the platform without them. | Templates in `docs/compliance/`: a data processing agreement for schools, a sub-processor list with regions, a privacy notice the school can publish to parents, and a retention schedule. **Closed** on 19 September 2026 by four documents in `docs/compliance/`: [`DATA_PROCESSING_AGREEMENT.md`](DATA_PROCESSING_AGREEMENT.md) (roles under the DPDP Act, processing instructions, security measures by reference to the auth documents, the two breach clocks, audit rights, deletion at term end through the anonymisation and sweep routes), [`SUB_PROCESSORS.md`](SUB_PROCESSORS.md) (Vercel, Neon, Resend, Sentry, Better Stack and GitHub, each with purpose, data, region and the date the region was checked), [`PRIVACY_NOTICE.md`](PRIVACY_NOTICE.md) (for parents and staff, with the five consent purposes taken from `CONSENT_PURPOSES`), and [`RETENTION_SCHEDULE.md`](RETENTION_SCHEDULE.md) (section 7 of this document in school-facing words). They are templates marked as not legal advice: party names, notice periods, liability, jurisdiction, the grievance officer and four vendor account regions (the Blob store, the Resend sending region, the Sentry organisation region, the Better Stack region) are placeholders, because they are commercial choices or dashboard settings rather than facts in the repository. No school has signed any of them. |
| F19 | **Log retention is undefined**, and CERT-In requires 180 days within India. | Choose the log sink and region deliberately and write the retention into the runbook. **Decided, region open**: retention is 180 days in `access_log`, swept daily by `sweep_access_log()`. The database is in Neon `us-east-1` and Neon has no Indian region, so the India requirement is not met; the gap is written down in `docs/compliance/INCIDENT_RESPONSE.md` section 9. **Region decided** on 19 September 2026 in [`docs/compliance/HOSTING_REGION.md`](HOSTING_REGION.md): stay on Neon `us-east-1` while the database holds invented people, and move to Supabase `ap-south-1` Mumbai (Pro, $25 a month, checked 19 September 2026) at the same time as setting the Vercel function region to `bom1`, triggered by the first signed school or by any tender that names Indian hosting. The document carries the costed alternatives (AWS RDS Mumbai, Aiven Mumbai), what each changes in the runbook, and the migration steps down to recreating the four logins. Nothing is provisioned, so the CERT-In 180-days-in-India requirement is still not met and every prospective school must be told in writing where its data would sit. |

## 6. Proposed tasks

Three stacked tasks after the hosting work, in this order.

**Task 12: data lifecycle and consent — delivered 18 September 2026.** F1, F2, F3, F4, F5, F9, F13, F14, F15. Backend and contracts, one migration series, sweeper endpoint, anonymisation workflows, consent capture in admission and on the parent screen, APAAR encryption and masking, roster projection fix. Exit check: a parent's consent is recorded and withdrawable; a student who left three years ago has no sensitive fields left and the register row remains; a used OTP, an expired preview and an abandoned session are gone within a day; the reason text of a pay change is not in `audit_events`; the roster query never selects medical notes for a basic reader; APAAR never appears unmasked without the sensitive read.

**Task 13: observability and incident readiness — delivered 19 September 2026.** F6, F7, F8, F10, F11, F12, F19. Read auditing, structured access log, denial rows, account lockout and disable, subject-access export, the incident runbook with both notification clocks, Sentry wiring, log retention decision. Exit check: for any student, the system can list who read the record in the last year; a denial burst from one membership raises an alert naming the membership; an identity can be locked and disabled; a subject-access export for one student is produced and audited. The region half of F19 stays open and moves to Task 14.

**Task 14: governance — delivered 19 September 2026.** F16 (except repository visibility), F17, F18, and the region half of F19. CODEOWNERS, Dependabot, a security policy, three separate CI checks and a blocking dependency-advisory gate; a branch ruleset, secret scanning with push protection and Dependabot alerts applied in GitHub settings; the backup and restore procedure with a tested rehearsal checker and a restore log; the four school-facing documents; and the hosting-region decision. What it did not do: make the repository private (GitHub Free would then drop rulesets, code owners and secret scanning; the fix is a $4 per user per month paid plan), schedule the weekly dump (no Indian bucket, no key holder), rehearse a restore against production, or move the database to India.

One thing to do this week without waiting for a task: `chmod 600 apps/api/.dev/sunrise-logins.csv` if the development credentials file still exists from before Task 12.

## 7. Retention schedule (adopted)

Adopted in Task 12 and to be published to schools. The periods the code acts on are constants in `@erp/contracts` (`RETENTION`), and the enforcing route or sweep function for each line is listed in [the release runbook](../auth/RELEASE.md#62-the-retention-schedule). Periods start when the purpose ends, not when the row is created.

| Data | Keep while | Then |
|---|---|---|
| Student register fields (name, admission number, dates, class history, outcome) | Permanently, as state education rules require an admission register | Nothing; these are the register |
| Student sensitive fields (birth date, Aadhaar fragment, APAAR, category, religion, medical notes, address, documents) | Enrolled, plus 3 years after leaving | Anonymise: clear the fields, delete the documents |
| Guardian records | While any linked student is within the period above | Delete when the last link ends |
| Staff records (salary, identifier fragments, private contact) | Employed, plus 8 years after leaving for statutory payroll records | Anonymise contact and identifiers; keep employment dates and designation |
| Login identity and credentials | While the person holds any active membership | Delete credentials 30 days after the last membership ends; keep `auth_user.id` and name for audit attribution |
| Sessions, OTPs, reset tokens, throttle rows | Until expiry | Sweep daily |
| Import previews | 24 hours | Sweep daily |
| Invitations | Until terminal | Blank the identifier at that point; delete the row after 90 days |
| Delivery outbox | 90 days | Sweep |
| Audit events | 7 years, covering a child's time at the school plus the DPDP one-year log requirement | Archive whole years to cold storage; never edit |
| Access logs | 180 days within India (CERT-In), 1 year preferred (DPDP Rules) | Provider retention setting |
| Pupil attendance marks (`attendance_entries`) | With the pupil's sensitive fields: enrolled, plus 3 years after leaving | Nothing prunes them today; anonymisation clears nothing, because a mark is not identifying |
| Staff attendance marks (`staff_attendance_entries`) | With the staff record: employed, plus 8 years after leaving | Nothing prunes them today |
| Exam marks, publications and co-scholastic grades (`exam_marks`, `exam_publications`, the grades in `report_card_entries`) | Permanently, as the academic record | Nothing; a school issues mark statements and transfer certificates from them years later |
| Published report cards (`report_card_versions.content`) | Permanently, with the exam results | Nothing |
| The class teacher's remarks (`report_card_entries.remarks`, `report_card_versions.remarks`) | With the pupil's sensitive fields: enrolled, plus 3 years after leaving | Anonymise: cleared in both tables; the database allows exactly that change to a published card |

## 8. SOC 2 readiness map

Common Criteria of the Trust Services Criteria against what exists. "Evidenced" means a test or configuration in the repository proves it; "documented" means a runbook says it; "absent" means neither.

| Criterion | State | Evidence or gap |
|---|---|---|
| CC1 Control environment (policies, roles) | Partial | `SECURITY.md` is the disclosure policy and `.github/CODEOWNERS` names the owner of the migrations, the policy package, the permission contract and the compliance documents. `docs/compliance/INCIDENT_RESPONSE.md` names the incident, communications and technical roles, all held by one person. Missing: any other written policy (acceptable use, access, change, vendor), an org chart, and a second person for any role. |
| CC2 Communication (notices, contracts) | Documented, not evidenced | `docs/compliance/PRIVACY_NOTICE.md`, `DATA_PROCESSING_AGREEMENT.md` and `RETENTION_SCHEDULE.md` exist as templates with commercial terms as placeholders, and `SECURITY.md` gives an external reporting route with an unfilled contact address. Nothing has been published to a parent or signed by a school, so there is no evidence of communication, only the means. |
| CC3 Risk assessment | Partial | This document is the first. Repeat it yearly and after each major change. |
| CC4 Monitoring of controls | Partial | CI runs every suite on every change; no periodic access review, no alerting. Task 13. |
| CC5 Control activities | Evidenced | Permission gate, RLS, contracts, tests. |
| CC6 Logical and physical access | Mostly evidenced | MFA, sessions, least-privilege logins, RLS. Offboarding now ends sessions and sweeps credentials after thirty days (Task 12). Missing: account lockout and a periodic access review. Task 13. |
| CC7 System operations (detection, incidents) | Absent | No access log, no alerting, no incident plan. Task 13. |
| CC8 Change management | Mostly evidenced | A "Protect main" ruleset requires a pull request, up-to-date green checks, resolved threads, no force push and no deletion; `typecheck`, `lint` and `contracts` are separate required checks; `scripts/audit-deps.mjs` fails the build on an unlisted high or critical advisory or an expired exception; CODEOWNERS routes migrations, policy and permissions. Gap: zero required approvals, because one person maintains the repository, so no change is reviewed by anyone else. |
| CC9 Risk mitigation (vendors) | Documented, not evidenced | `docs/compliance/SUB_PROCESSORS.md` lists all six vendors with purpose, data, region and the date checked, and `docs/compliance/HOSTING_REGION.md` is the first costed vendor comparison. Gap: no vendor security review, no signed agreement with any of them, no re-check schedule, and four regions still read as placeholders because they are account settings. |
| Availability | Partial | Liveness check, rollback documented, Neon's six-hour history window live, and a backup and restore procedure written and tested locally (`docs/auth/BACKUPS.md`, `scripts/backup-dump.sh`, `scripts/restore-rehearsal.mjs`, `docs/compliance/RESTORE_LOG.md`). Gap: the weekly dump is not scheduled and has no destination, no restore has been rehearsed against production, Blob documents and `DATA_ENCRYPTION_KEY` have no backup at all, and there is no availability target or uptime evidence. |
| Confidentiality | Evidenced | Projections, RLS, private documents, the sealed APAAR id, the reason text out of the audit rows, and a roster query that selects no sensitive column. Task 12. |
| Privacy | Partial | Consent, retention and anonymisation are built (Task 12). The right of access — a subject-access export — is still missing; Task 13. |

The three tasks are done. The remaining distance to a SOC 2 Type I is organisational: written policies beyond disclosure and incident response, a second reviewer, an evidence-collection habit, turning the documented controls above into running ones, and the audit fee.

## 9. What was checked

The inventory was built by reading every migration in `packages/db/migrations`, every contract in `packages/contracts/src`, every read projection and write path in `apps/api/src/modules`, the delivery and invitation services, the audit helper and all fifty-six audit call sites, the request logger and error handler, the development seed scripts, and the browser session and HTTP client. The controls map was built from the auth handover documents, the CI workflow, the auth service, the tenant helper, the grants and triggers in the migrations, the security suite, and the GitHub repository settings readable to the author. The eight sharpest claims were re-verified line by line before this document was written.

## 10. Office feedback, September 2026: identifiers and photographs

A short assessment of the two new kinds of personal data, written when they were built.

**What changed.** A pupil may now have a whole Aadhaar number on file, a guardian may have an
office address, a PAN and an Aadhaar number, and a pupil or a staff member may have a photograph.
Every one of them is optional and every form says so.

**Why it is asked for.** Schools are asked for a pupil's Aadhaar number for scholarships, board
registrations and government schemes, and for a PAN on fee receipts; the office was keeping them on
paper or in a spreadsheet instead, which is worse for the family than keeping them here. A
photograph is what makes a roster usable at a glance.

**How the numbers are held.** The whole number is sealed with the application encryption key
(`DATA_ENCRYPTION_KEY`) exactly as the APAAR identifier already was, and stored beside the last four
digits. Nothing else keeps a copy: not a log line, not an audit row, not an export file. Screens,
lists, spreadsheets and PDFs print "ending 1234" and no more. The whole number can be read back only
through one route per number, behind `students.read_sensitive` for the pupil's and
`students.read_guardians` for the guardian's, and every read writes an audit row naming who looked.
The database refuses a last-four value that is not the right shape. Anonymising a record clears the
encrypted number and the last four digits together.

One copy is deliberately different. A subject access export is the answer to a person asking what we
hold about them, so their own Aadhaar number is opened in full there, exactly as their APAAR
identifier already was. A guardian's own PAN and Aadhaar stay as their last four characters even in
that file: a guardian is a different person from the child the request is about, and a request made
about a child is not a request for a parent's identity documents. A guardian who wants their own
copy asks for it in their own name.

**How photographs are held.** The bytes go to the private document store under a key no response
ever names, and are served only by a streaming route that decides the same permission as opening the
record. The answer carries `cache-control: private, no-store` and `x-content-type-options: nosniff`, so
nothing keeps a copy and no browser guesses a different type. The file type is decided by reading
the first bytes, never by the name or the claimed type, and only JPEG, PNG and WebP up to one
megabyte are accepted. The blocks a camera writes into a photo, including where it was taken, are
stripped before the file is stored, and the file is rebuilt from the parts that were actually read,
so a picture whose own structure does not add up is refused instead of half stored. Nothing reaches
the store until the caller has been allowed to change that exact record. A pupil's photograph needs the `photographs` consent: withdrawing
it removes the picture in the same transaction and refuses the next upload. Anonymisation removes
the bytes.

**What is proved.** `tests/security/office-feedback.test.ts` (matrix rows `photo-record-scope`,
`identifier-field-masking`, `identifier-never-whole`) submits a number once and then hunts for it in
every detail, list, search, subject-access, spreadsheet, PDF and audit row, and drives every refusal
around a photograph. `apps/api/tests/images.test.ts` proves the metadata stripping.

**What is left.** The reveal routes have no second factor of their own; they inherit the session's,
which for an office role means MFA at sign-in. If a school wants a fresh second factor at the moment
of a reveal, that is a change to make once and for APAAR at the same time.

## 11. Fees, September 2026

A short assessment of the fee records, written when the module was built (Task 19).

**What changed.** The system now holds what each pupil is charged, the optional fees they take, any
concession and the category it was given under, and a ledger of every payment, refund, cancelled
receipt and adjustment: number, date, amount by fee, mode, the cheque, UPI or bank reference, and
the payer's name where the office wrote one. Payments are recorded by hand. There is no payment
gateway, no online payment and no webhook, so no card number, UPI PIN or bank credential is ever
seen or stored. Choosing a gateway is a decision still to take.

**Purpose and basis.** Keeping the school's accounts. It is a new purpose, and it is not a consent
purpose: a school cannot take a fee without recording it and must keep its books. The privacy
notice and the processing agreement say so.

**Who reads it.** Owner, principal and accountant set, collect, read and export; the administrator
collects and reads; a parent reads their own children's statements and receipts; a teacher holds no
fee key at all. A parent reaches a fee row only through the pupil it belongs to, in the same
`own_children` term every other record uses.

**What keeps it honest.**

- Money is whole paise in a `bigint` from the database to the screen. Nothing is a float.
- The ledger is append-only in the database, not only in the API: the runtime login holds no
  DELETE, a trigger refuses every UPDATE but one, and a refund, a cancellation or a correction is a
  new row that points at the old one.
- A receipt number comes from the server's counter for the school and the year. No request can
  carry one.
- An amount never appears in `safe_changes`. The audit row says what happened and to which record;
  the amount stays in the fee tables. A reason somebody typed (for a concession, a refund, a
  cancellation or an adjustment) is a redactable audit note and is stored nowhere else, so a
  family's hardship is never a column.
- A concession carries a category from a closed list and no free text.

**Anonymising a pupil, decided.** The law pulls two ways: a pupil's personal details go three years
after leaving, and account books stay for eight. The decision: the money rows stay exactly as
written, with their numbers and their bank or cheque references, because those are the evidence
the accounts rest on and they identify a transaction, not a person. The payer's name is the only
identifying thing on a receipt beyond the pupil, so anonymisation clears it; that is the single
edit the ledger trigger allows. The rows stay linked to the pupil's register line, which the school
keeps permanently anyway. Concessions and optional fees stay with the ledger, because a balance
cannot be explained without them.

**Retention.** Eight years after the pupil's last fee transaction, as for staff pay. Nothing prunes
the ledger today; like the audit trail, removal at the end of the period is a decision for the
school and a task for later, and it is listed as a gap.

**Where it sits.** In the same United States database as everything else. Building and releasing
the module is fine, but **no real school's money goes in until the database has moved to an Indian
region** (Task 17).

## 12. Attendance, September 2026

A short assessment of the attendance records, written when the module was built (Task 20).

**What changed.** The system now holds, for every pupil and every school day, one of five marks (present, absent, late, leave, half day), and the same for every staff member. Each mark is a row that is never edited: a later save or an office correction is a new row that supersedes the old one, and the database refuses every UPDATE and DELETE. Who marked, and when, is on the row. The reason an office correction was made is a redactable audit note and is stored nowhere else.

**Purpose and basis.** Running the school and keeping the attendance register the education rules require. It is not a new consent purpose: a school cannot run a class without knowing who was in it. The privacy notice and the processing agreement say so.

**Who reads it.** Owner, principal and admin read, mark, correct and export every register, and the staff register too. A teacher reads and marks the sections they are assigned to and reads their own month of the staff register. A parent reads their own child's calendar and percentage, for every year the child was at the school, and nothing about any other child. The accountant reads the staff register as payroll input and holds no key over pupil attendance. Every read is bounded by the same plan its detail read uses, so a list never carries a row a person could not open.

**What keeps it honest.**

- Marking a day is one write of the whole roster, derived by the server from the enrolments. A body that names a pupil who was not in that section on that date is refused with nothing written.
- A teacher's window closes at the end of the day in the school's timezone. After that only the office corrects, with a reason.
- Nothing is edited. `attendance_entries` and `staff_attendance_entries` take INSERT and nothing else, by grant and by trigger. The current mark is the newest row; every earlier row stays.
- `safe_changes` carries the section, the year, the date and counts. A reason somebody typed is an audit note.
- Nobody marks their own attendance. The staff register refuses a body that names the caller's own row.
- The percentage is worked out from the same rule everywhere (one set of common table expressions), so a screen, a file and the dashboard cannot disagree.

**Anonymising a pupil, decided.** The marks stay. A mark says "present" or "absent" against a register line the school keeps permanently anyway; it identifies nobody on its own, and the register the education rules require is a register of attendance. So the anonymisation step clears nothing in these tables. The retention period is nevertheless the pupil's sensitive period (enrolled plus three years), and staff marks keep with staff records (eight years); nothing prunes either today, which is listed as a gap, as it is for the fee ledger.

**Where it sits.** In the same United States database as everything else. No real school's data goes in until the database has moved to an Indian region (Task 17).

## 13. Exams and report cards, September 2026

A short assessment of the exam records, written when the module was built (Task 21).

**What changed.** The system now holds, for every pupil, paper and exam component, a mark (a number with at most one decimal place) or a status (absent, medical leave, exempt), the co-scholastic grades and the class teacher's remarks for each term, and every report card the school publishes, frozen as it was published. Each mark is a row that is never edited: a later save or an office correction is a new row that supersedes the old one, and the database refuses every UPDATE and DELETE. Every change after the first save carries the kind of reason (re-check, entry error, other) on the row; the words someone typed are a redactable audit note and are stored nowhere else. The school's logo is an image in the private document store, like a pupil photograph, and prints on the card.

**Purpose and basis.** Running the school: assessing pupils and issuing the report cards and mark statements a school must issue. It is not a new consent purpose. The privacy notice and the processing agreement say so.

**Who reads it.** Owner, principal and admin set the exams up, read, correct, publish and export everything. A subject teacher reads and enters the marks of their own subject in their own section, and nothing of another subject in the same class: for exams and report cards the class-teacher relationship counts only for the class teacher, never for a teaching assignment. A class teacher reads every subject of their own class, enters the co-scholastic grades and remarks, and reads and prints their class's cards. A parent reads their own child's published results and report cards for every year the child was at the school, and nothing unpublished: the scope term itself matches published rows only, so no screen can show them by mistake. When the school chooses grades, a parent receives grades only; the marks are removed on the server. The accountant reads nothing here.

**What keeps it honest.**

- The marks sheet is one write of the whole paper. The roster is the pupils enrolled in the section on the exam's first day, derived by the server; a body naming anybody else is refused with nothing written.
- The subject teacher's window closes at the end of the re-check deadline in the school's timezone. After that only the office changes a mark, always with a reason, and results can be published only after the deadline and only when every pupil has a mark or a status.
- Nothing is edited. `exam_marks` and `exam_publications` take INSERT and nothing else, by grant and by trigger. A published card can only have its remarks cleared.
- A parent sees each mark as it stood when the results were last published. A correction after publishing stays invisible to the family until the office publishes again, and a card is republished as a new version with the earlier one kept.
- `safe_changes` carries ids, counts and the kind of reason. Remarks are never in an audit row at all, so clearing them clears them.
- No class average is shown to a parent, so a family cannot work out another child's marks.

**Anonymising a pupil, decided.** Marks, grades and published figures stay: they are the academic record a school must be able to certify, and a mark on its own identifies nobody. The class teacher's remarks are free text about a child and are cleared by the anonymisation step, in the working record and on every published version; the database allows exactly that change and no other.

**Where it sits.** In the same United States database as everything else. No real school's data goes in until the database has moved to an Indian region (Task 17). Result notices to parents are sent by the messages module (section 14), which checks the family's consent.


## 14. Messages, September 2026

A short assessment of the messages module, written when it was built (Task 22).

**What changed.** The system now sends and keeps the school's announcements: notices a member of staff writes to the whole school, a class, a section, the staff or one pupil's family, and seven kinds of message the software sends by itself (a pupil marked absent today, results published, a report card published, fees falling due, fees overdue, a pupil's birthday, a staff member's birthday). Each message is kept once, with up to three attached files, and each person it was for has a row saying whether it reached them in the app or by email, whether the email went, a masked address and when they opened it in the app. Parents cannot reply. Email goes through Resend; text messages wait for Task 16.

**Purpose and basis.** Contacting a family about their child and the school. For families this is the `communication` consent purpose, and the software enforces it rather than leaving it to a screen: a guardian receives a message only when their newest answer for at least one of the pupils through whom they are in the audience is `given` and the office has not switched their notifications off. With no answer, or a withdrawal, nothing goes in the app or by email, and the delivery record says so, which is the evidence a school needs when a parent asks why they were not told. Staff messages are part of employment and need no consent.

**Who reads it.** The office reads every message and its delivery record. A teacher (class teacher or subject teacher alike) writes to and reads the messages of their own sections and families of pupils in them, and nothing else. Everybody reads the messages addressed to them and the ones they wrote, and nothing addressed to another person: a message to one guardian is not readable by the child's other guardian through the child, so consent given by one parent never opens a message to the other. A draft is its author's alone. Delivery figures and the recipient list are shown only to the author and to the office or a teacher of that section.

**What keeps it honest.**

- The words of a message live in one row and nowhere else: not in a log line, not in an audit row's `safe_changes`, not in an audit note, not in the delivery outbox. Audit rows carry ids, kinds, statuses and counts.
- Once a message has gone out the database refuses any change to its words or its audience. Withdrawing it hides it from every inbox; the screen says an email already sent cannot be recalled.
- A scheduled message is decided again for its author when its time comes, so a teacher who has left a section sends nothing there.
- Read receipts are opens in the app only. There is no tracking pixel and no rewritten link in an email.
- An email is recorded as sent only when the provider accepted it. A failure is retried four times over about two and a half hours and then recorded as failed.
- The seeded test schools use reserved addresses (`.test`, `.invalid`, `example.com`), which the software never hands to the provider.
- Files are kept in the private document store and served only through a permission-checked route; pictures lose their metadata as photographs do.

**Retention and anonymisation.** Two years after a message went out (or was withdrawn or cancelled), the nightly sweep deletes its files and then the message with its delivery record; a draft nobody touched for a year goes too. Anonymising a pupil clears the words of every message about that pupil and the masked addresses of the guardians anonymised with them; anonymising a staff member does the same for messages to them.

**Sub-processor.** Resend now carries message bodies and files about children, not only credentials. The sub-processor list says so. Its account data and logs are in the United States.

**Where it sits.** In the same United States database as everything else. On 23 September 2026 the product owner decided to stay on Neon in us-east-1 for the test environment and to move the database to an Indian region only when the first real customer signs, before any of their data goes in (Task 17). No real school's messages are sent before then.

## 15. Student login, September 2026

A short assessment of pupils' own logins, written when they were built (Task 23).

**What changed.** A pupil in Class 9 to 12 can sign in with the school's login code, their admission number and a password, and read their own timetable, attendance, published results and report cards, and the notices the school addressed to pupils. The school creates the login when the pupil is admitted or promoted into those classes and texts a generated password to the primary guardian's phone; the pupil chooses their own password at first sign-in. Only the office switches a login off; it ends when the pupil leaves.

**Purpose and basis.** Education: the pupil seeing their own record is the purpose the school already holds it for, and nothing new is collected from the child. The login itself holds only the pupil's name, a generated address that is never used, the password hash and the sessions. A notice to pupils is shown only in the school's own app, never by email or text to the child, so it needs no separate consent; notices to families keep the `communication` consent exactly as before.

**Who reads what.** A pupil reads their own record and nothing about any other pupil, their guardians, fees, consents, documents, health or identity numbers. Results and report cards reach them only once published, exactly as for a parent. A notice to families is never in a pupil's inbox and a notice to pupils is never in a guardian's. The office sees each pupil's login state, never the password or the generated address.

**What keeps it honest.**

- The generated password exists only in memory between generation and the text message. It is never stored, logged, audited or returned; the outbox row keeps a masked number only.
- The email sign-in door refuses a pupil's generated address, so a pupil signs in only through the school code and admission number, and every failure (unknown school, unknown number, wrong password, switched off) looks the same. Ten wrong passwords lock the login for fifteen minutes, as for adults; the office's password reset clears the lock.
- Until the pupil chooses their own password, the API refuses every school route.
- A switched-off or ended login loses every live session on its next request.
- Every issue, reset, switch-off and switch-on is one audit row naming the pupil; the switch-off reason is a redactable note.

**Retention.** The login ends when the pupil leaves or is anonymised; its credentials are deleted 30 days later by the sweep that already removes adults' credentials. Pupil message rows follow the two-year messages rule.

**Open point.** Text messages are still held for testers (Task 16), so in a real school the password text needs the SMS provider before logins are useful.
