# Incident response

What to do when children's data may have been seen, changed or taken by someone
who should not have it. Written for the person on call at two in the morning:
read section 2, then work down section 4 in order. Nothing here needs a meeting
first.

Added in Task 13 to close finding F8 of [the data protection assessment](./DATA_PROTECTION.md).

## 1. Roles

| Role | Does | Who today |
|---|---|---|
| Incident lead | Decides severity, keeps the incident record, calls the end of the incident | The repository owner |
| Communications | Writes and sends the CERT-In, Board and affected-person notices, talks to the school | The repository owner |
| Technical | Contains, collects evidence, fixes | The repository owner |

One person holds all three until there is a team. That is honest, not
comfortable: with one person, containment comes first and the notices are
written from the incident record afterwards, inside the clocks in section 5.

The incident record is a single dated file kept outside this repository, with a
timeline in UTC and IST, every command run, every query result, and who was told
what and when. It is the evidence for both regulators and the only thing that
makes the review in section 8 possible.

## 2. Severity

Decide in one minute. If unsure, pick the higher one; downgrading later is free.

| Level | Meaning | Examples | First action |
|---|---|---|---|
| S1 | Personal data of children or staff has left the system, or an account that could read it is in the wrong hands | A leaked database URL, a stolen session in use, an export downloaded by a stranger, a `DATA_ENCRYPTION_KEY` in a public place | Everything in section 4, now. Both clocks in section 5 start at the moment you believed it |
| S2 | Someone reached data they should not have, inside the system | One membership walking through records it cannot open, a permission bug found in production, a parent shown another family's child | Contain the account, collect evidence, assess whether anything was actually read. The clocks start only if it was |
| S3 | A control failed with no data reached | The access log stopped writing, the sweep stopped running, Sentry silent, backup not restorable | Fix and record. No notification |

Severity is about what was reached, not about how alarming it looked.

## 3. How an incident reaches you

- **A Sentry denial burst.** One `denial burst` event per membership, level
  error, fingerprint `denial-burst:<membershipId>`, tags `schoolId`,
  `membershipId` and `count`. Twenty or more refusals from one membership in ten
  minutes. Treat as S2 until the evidence says otherwise.
- **Sentry error reports** and the `ACCESS_DENIED` / `AUTHENTICATION_REQUIRED`
  log alerts in [the release runbook](../auth/RELEASE.md#7-alerting-on-repeated-denied-access).
- **A school or a parent tells you.** Someone saw a record they should not have,
  or someone is asking questions about a child that only the system could answer.
- **The access log.** `access_log` holds one row per `/api` request for 180
  days; the queries in section 6 are how you read it.
- **A provider notice.** Vercel, Neon, Resend or Sentry telling you about their
  own breach. Their incident is your incident from the moment you are told.

## 4. Containment, in order

Do not skip a step because the next one looks more decisive. Record each command
and its output in the incident record as you go.

1. **Disable the identity you suspect.** This ends every session it holds.

   ```sh
   pnpm --filter @erp/api ops:identity -- --email person@example.com --disable
   ```

   It prints one line, for example `disabled 1 identity, ended 2 sessions`, and
   never echoes the address, so write the `auth_user.id` from the query in
   section 6 into the incident record instead. `--enable` reverses it and
   `--unlock` only clears a lockout. The script reads `AUTH_DATABASE_URL`; run
   it with the production value from the secret store, from your own machine,
   not from a shared shell.

2. **Suspend the memberships.** A disabled identity cannot sign in, but the
   person may hold memberships in several schools and may have a second
   identity. Suspend each membership through the member directory
   (`POST /api/schools/:schoolId/members/:membershipId/suspend`) or from the
   Access screen. Suspension bumps the school's access version, so the next
   request on any live session in that school is refused.

3. **Rotate `AUTH_SECRET` if a session or cookie may be in the wrong hands.**
   This signs out every person in every school at once. Tell the school first if
   you can; do it anyway if you cannot. Set the new value in the Vercel
   environment and redeploy.

4. **Rotate provider keys** that may be exposed, in this order: database
   passwords for the four logins, `CRON_SECRET`, `BLOB_READ_WRITE_TOKEN`,
   `RESEND_API_KEY`, the Sentry DSN. Each is one environment variable and a
   redeploy.

5. **Do not rotate `DATA_ENCRYPTION_KEY`.** The sealed APAAR ciphertexts are
   `v1.<iv>.<tag>.<ciphertext>` under the current key; changing it makes every
   sealed value unreadable with no way back. A key rotation needs a re-seal
   procedure — a second key version accepted for reading while every row is
   re-sealed — and that procedure does not exist yet. If the key itself is
   exposed, treat it as S1, keep the key in place, and write the re-seal work
   into the incident record as a required follow-up.

6. **Only then, fix the cause.** Containment before the patch: a fix deployed
   while the attacker still holds a session changes nothing.

## 5. The two clocks

Both start when you first believe personal data was reached, not when you finish
investigating. An incomplete notice sent on time is correct; a complete notice
sent late is not.

| Who | When | What the notice must contain |
|---|---|---|
| **CERT-In** (incident@cert-in.org.in) | Within **six hours** of noticing, for any S1 and for an S2 where data was reached | When it happened and when it was noticed (IST), the kind of incident, the systems affected, what was taken or reached, how many people, the current status, what has been contained, and a contact person with a phone number |
| **Data Protection Board of India** | **Without delay** on noticing, then a **full report within 72 hours** | First notice: the nature, extent and timing of the breach, the personal data involved, the likely consequences, and the measures being taken. Full report: the above plus the root cause, the remedial measures taken and planned, the intimations already sent to affected people, and a copy of that intimation |
| **Affected people** (each parent or staff member, and the school) | **Without delay**, separately and directly; do not wait for the 72-hour report | In plain language: what happened, which of their data was involved, the likely consequences, what they should do now, and where to reach us. One notice per person, not a note on a website |

The school is the data fiduciary for its pupils and we are its processor: tell
the school at the same time you tell the Board, and send the parent notices with
the school, not around it. Names, addresses and identifiers never go into the
regulator notices; counts and categories do.

## 6. Evidence

Two tables answer nearly every question. Take both readings early, before the
180-day access log window or a containment step changes anything, and paste the
results into the incident record.

Run these with the **migrator** login (`MIGRATION_DATABASE_URL`). `access_log`
grants `INSERT` to the runtime login only and no application role can read it,
so there is no API path to this data. This is the one permitted direct database
read, and the incident record must say who ran it, when and why; anything read
outside an incident record is itself an incident.

**What one membership did, and where from:**

```sql
SELECT at, method, route, status, code, ip_hash, duration_ms, request_id
  FROM access_log
 WHERE membership_id = '<membership uuid>'
   AND at >= '<from timestamptz>' AND at < '<to timestamptz>'
 ORDER BY at;
```

`route` is the route pattern, never the URL, so it says `GET
/api/schools/:schoolId/students/:studentId` and not which child. `ip_hash` is a
keyed HMAC of the address, so two rows can be compared and an address can be
confirmed by hashing a candidate with `AUTH_SECRET`, but the log holds no
address. If `AUTH_SECRET` was rotated in step 3, hashes before and after the
rotation do not compare.

**Who read or was refused one child's record:**

```sql
SELECT created_at, action, result, actor_user_id, actor_membership_id,
       summary, safe_changes
  FROM audit_events
 WHERE school_id = '<school uuid>'
   AND target_id = '<student uuid>'
   AND created_at >= '<from timestamptz>'
 ORDER BY created_at;
```

Every detail read of a student, their guardians, their consents, a staff record,
an APAAR reveal, a document download and a subject-access export leaves one
`allowed` row here with the blocks that were returned; every refusal leaves one
`denied` row. Lists leave none, so absence of a row means nobody opened that
record, not that nothing happened. The same rows are readable through the audit
screen under `audit.read`, which is the better route when a school asks.

Also collect: the Sentry issue and its events, the Vercel deployment id running
at the time, and the range of `auth_session` rows for the identity (`SELECT id,
created_at, updated_at FROM auth_session WHERE user_id = '`<user uuid>`'`) before
you disable it, because disabling deletes them.

## 7. Notice templates

Short on purpose. Fill the placeholders, send, then improve in the follow-up.

**CERT-In, within six hours.**

> Subject: Security incident report — School ERP — `<DD Month YYYY>`
>
> Reporting entity: `<entity name, address, contact person, phone, email>`.
> Incident noticed at `<time IST>` on `<date>`; believed to have begun at `<time IST>`
> on `<date>`. Type: <unauthorised access to personal data / account compromise /
> data leak>. Affected systems: the School ERP application hosted on Vercel and
> its PostgreSQL database hosted on Neon (us-east-1). Data involved: <categories,
> for example student register fields and dates of birth> for approximately
> `<count>` people across `<count>` schools. Current status: <contained / under
> investigation>. Actions taken: <disabled identity, suspended memberships,
> rotated AUTH_SECRET, …>. Contact for follow-up: `<name, phone, email>`.

**Data Protection Board, first notice and 72-hour report.**

> We are reporting a personal data breach affecting `<count>` data principals,
> mostly children, whose data we process on behalf of `<school names>`.
>
> Nature and extent: `<what happened, what was reached>`. Timing: began <date,
> time IST>, noticed `<date, time IST>`, contained `<date, time IST>`. Personal data
> involved: `<categories>`. Likely consequences: `<plainly stated>`. Measures taken
> and proposed: `<containment steps, fixes, follow-up>`. Intimation to affected
> data principals: sent on `<date>` by `<email / SMS through the school>`; a copy is
> attached. Root cause: `<for the 72-hour report>`. Contact: `<name, email, phone>`.

**Affected person, without delay.**

> Subject: An incident affecting your child's records at `<school name>`
>
> Dear `<name>`,
>
> On `<date>` we found that `<plain description of what happened>`. Information
> about `<child's name>` that may have been seen includes <categories, in plain
> words: name, class, date of birth>. It did not include <what was not
> involved>.
>
> We have <what was done: ended the account's access, signed everyone out,
> fixed the fault>. We have told CERT-In and the Data Protection Board.
>
> There is nothing you need to do / We suggest you `<action>`. If you have any
> questions, write to `<address>` or contact the school office.
>
> `<Name>`, on behalf of `<entity>`

## 8. After it is over

Within five working days of closing the incident, the lead writes a review in
the incident record: the timeline, what was reached, what detected it and how
long that took, what the containment steps actually did, and what would have
prevented it. Turn each preventable cause into a repository issue with an owner
and a date; a review with no issues is a review that learned nothing. Then check
whether this document was right — if a step here was wrong or missing at two in
the morning, fixing it is part of closing the incident.

## 9. Known gaps

- **Region.** The database and every access-log row live in Neon `us-east-1`.
  CERT-In direction 5 requires these logs to be kept within India for 180 days.
  Neon has no Indian region today, so the requirement is recorded and not met.
  The decision — an Indian-region database, an Indian-region log copy, or a
  different provider — belongs to Task 14; until it is taken, no school outside
  the internal test group should be onboarded, and any school that is must be
  told where its data sits.
- One person holds all three roles, so there is no separation between the person
  who caused an incident and the person who investigates it. Task 14.
- There is no re-seal procedure for `DATA_ENCRYPTION_KEY`, so an exposed key
  cannot be rotated (section 4, step 5).
- No out-of-hours paging: Sentry sends email. Anything that must wake someone
  needs a phone route configured.
