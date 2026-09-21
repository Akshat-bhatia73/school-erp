# Data processing agreement (template)

This is a template for the school's counsel, not legal advice. It is written so that a school and
we can see what each side is promising before either pays a lawyer. Everything in square brackets
must be filled in, and the whole document must be reviewed and adjusted by the school's legal
adviser and ours before it is signed. Nothing here creates an obligation until it is signed.

## Parties

This agreement is made on `[date]` between:

- **`[School name]`**, `[address]`, referred to as **the School**; and
- **`[Provider legal name]`**, `[address]`, referred to as **the Provider**.

It supplements the services agreement dated `[date of the services agreement]` between the same
parties. Where the two disagree about personal data, this agreement wins.

## 1. Roles

Under the Digital Personal Data Protection Act, 2023:

- The School is the **Data Fiduciary**. It decides why and how pupils', parents' and staff personal
  data is processed. It is responsible for notice and consent, including verifiable parental
  consent for a child's data.
- The Provider is a **Data Processor**. It processes personal data only on the School's
  instructions.
- Where the School's pupils are children, the School is responsible for obtaining parental consent
  and for the requirements that apply to children's data. The Provider supports this by recording
  consent against the purposes listed in clause 3.

Nothing in the services makes the Provider a fiduciary of the School's data.

## 2. What is processed

| Item | Detail |
|---|---|
| Subject matter | Running the School's pupil, staff and timetable records in the Provider's software |
| Duration | The term of the services agreement, plus the deletion window in clause 10 |
| Nature and purpose | Storing, organising, displaying and deleting school records so School staff can do their jobs |
| Categories of data subject | Pupils (children), their parents and guardians, School staff, and any other person the School gives a login |
| Categories of personal data | As set out in section 3 of the Provider's data protection assessment: pupil identifiers and register fields; sensitive pupil fields including date of birth, category, religion, an encrypted Aadhaar number, the APAAR identifier, a photograph and free-text medical notes; guardian contact, office address, income and encrypted PAN and Aadhaar numbers; staff salary, identifier fragments, bank account fragment and a photograph; and login credentials |

The Provider does not sell personal data, does not use it to train any model, and does not use it
for its own purposes.

## 3. The School's instructions

The Provider processes personal data only to provide the services, and only on documented
instructions from the School. The services agreement, this agreement and the School's use of the
software through its own accounts are those instructions. The Provider will tell the School if an
instruction appears to breach the Act rather than carry it out silently.

Consent is recorded in the software against these purposes, and no others:

| Purpose | Meaning |
|---|---|
| `education_records` | Keeping and using the child's academic and enrolment record |
| `health_information` | Holding medical notes, allergies and blood group so the School can act in an emergency |
| `photographs` | Taking and using the child's photograph |
| `communication` | Contacting the parent or guardian about the child |
| `third_party_services` | Sharing the child's data with a third party the School names |

Each consent is stored as a dated event with who recorded it and how (in person, a signed form, or
the parent portal). A withdrawal is a new event, so the history is never overwritten. The School
decides what each purpose means to its parents and writes it in its own privacy notice.

## 4. Confidentiality

The Provider's personnel who can reach personal data are bound by confidentiality obligations that
survive the end of their engagement, and are only given the access their work needs.

## 5. Security

The Provider maintains the technical and organisational measures described in its own engineering
documents, which are open and can be read by the School:

| Measure | Where it is written |
|---|---|
| Least-privilege database logins, row-level security forced on every tenant table, and a trusted tenant transaction | `docs/auth/DATABASE.md` |
| One permission policy service; every read and every list filtered by the same decision, so a list can never show a row whose detail page would be refused | `docs/auth/AUTHORIZATION.md` |
| Passwords hashed, multi-factor authentication for privileged roles, account lockout after repeated failures, server-derived sessions, and the ability to disable an identity and end all its sessions at once | `docs/auth/AUTHENTICATION.md` |
| Every protected route declares its permission before the handler runs and parses its response through a contract, so no field can leak by accident | `docs/auth/PROTECTED_APIS.md` |
| Sensitive text such as the APAAR identifier encrypted at rest with AES-256-GCM | `docs/auth/RELEASE.md` section 2 |
| An audit event for every write and every sensitive read, kept for seven years and never editable | `docs/auth/RELEASE.md` section 6 |
| One access-log row per API request, holding a route pattern and a hashed IP address and no URL, query string or name, kept 180 days | `docs/auth/RELEASE.md` section 6.3 |
| Pupil documents in a private store, served only through a permission-checked route; the store URL never reaches a browser | `docs/auth/RELEASE.md` section 0.1 |
| Backups and a rehearsed restore | `docs/auth/BACKUPS.md` |
| Incident detection, containment and notification | `docs/compliance/INCIDENT_RESPONSE.md` |

The Provider will not weaken these measures during the term. If a measure changes materially, the
Provider tells the School.

**Known gap, disclosed before signature.** The database and every log row are hosted outside India,
in AWS `us-east-1`. CERT-In direction 5 requires certain system logs to be kept within India for
180 days. The retention is met; the location is not. See
[the hosting region decision](./HOSTING_REGION.md). The School signs knowing this.

## 6. Sub-processors

The School gives general authorisation for the Provider to use the sub-processors listed in
[SUB_PROCESSORS.md](./SUB_PROCESSORS.md), which forms part of this agreement. The Provider will:

- give the School at least `[30]` days' notice before a new sub-processor starts handling the
  School's data;
- put obligations on each sub-processor no weaker than these; and
- remain liable for its sub-processors' acts as if they were its own.

If the School objects on reasonable data protection grounds within the notice period, the parties
will discuss an alternative in good faith. If none is workable, the School may terminate the
affected service without penalty for the unused period.

## 7. Breach notice

The Provider will tell the School **without undue delay and in any event within `[24]` hours** of
becoming aware that the School's personal data has, or may have, been reached, changed or taken by
someone who should not have it. The notice will contain what is known at the time, and will be
updated as more is learned; an incomplete notice on time is better than a complete one late.

The Provider's own regulatory clocks, which run in parallel and are set out in
[the incident runbook](./INCIDENT_RESPONSE.md) section 5:

- **CERT-In** must be told within **six hours** of noticing a reportable incident.
- The **Data Protection Board of India** must be told **without delay**, with a **full report
  within 72 hours**.

Affected people must be told without delay, directly and in plain language. Because the School is
the fiduciary, the Provider will not contact the School's parents or staff about a breach without
the School, except where the law requires it or the School cannot be reached. The Provider will
give the School everything it needs to make its own notifications, and will keep its incident
record available to the School.

## 8. Helping the School with its duties

The Provider will assist the School, at no extra charge for reasonable volumes, with:

- **Requests from data principals.** A parent, adult pupil or staff member asking what is held
  about them, or asking for a correction or an erasure. The software produces a full record for a
  single pupil through the subject-access export, which the School can run itself. Corrections are
  made by the School in the ordinary screens.
- **Reporting to the Board**, security reviews and impact assessments, by providing the documents
  in `docs/auth` and `docs/compliance` and answering questions about them.
- **Grievances.** The School's grievance officer named in its privacy notice is the first contact
  for a parent. The Provider answers the School, not the parent.

The Provider will not respond to a data principal directly. It will pass the request to the School
within `[5]` working days and say that it has done so.

## 9. Audit

Once per year, and after a breach affecting the School's data, the School may:

- ask for and receive the Provider's current security documents, the sub-processor list, the
  restore rehearsal log and any independent report the Provider holds; and
- ask questions in writing, answered within `[15]` working days.

An on-site or third-party audit may be conducted where a regulator requires it, on `[30]` days'
notice, during business hours, no more than once a year unless a breach has occurred, by an auditor
who is not a competitor of the Provider and who signs a confidentiality undertaking. The School
bears the auditor's cost. Neither party's audit may put other schools' data at risk, so no audit
gives access to live records of another school.

## 10. Return and deletion at the end of the term

On termination or expiry, at the School's written choice:

- **Return.** The Provider produces a complete export of the School's records in a machine-readable
  form, within `[30]` days.
- **Deletion.** The Provider removes the School's personal data.

Deletion uses the same routes the software uses every day, not an ad-hoc script:

- Pupil sensitive fields are cleared and pupil documents deleted through the anonymisation route.
  The register fields a school must keep by law (name, admission number, dates, class history,
  outcome) survive by design, and the School decides whether to keep that register itself.
- Guardian records are anonymised when the last link to a pupil ends.
- Staff sensitive fields are cleared through the staff anonymisation route, keeping employment
  dates and designation.
- Transient copies, sessions, one-time codes, import previews, invitations and the delivery outbox
  are removed by the daily sweep.
- Credentials for people who no longer hold any membership are swept 30 days after the last
  membership ends, keeping only an identity id and a name so old audit rows still say who did what.
- Audit events are retained for their seven-year period unless the School instructs otherwise in
  writing, because they are the School's own evidence.

Backups age out on their own schedule; the Provider does not restore a deleted school from a backup
except to answer the School's own written request. Deletion is confirmed to the School in writing
within `[45]` days of the instruction.

The full schedule is in [the retention schedule](./RETENTION_SCHEDULE.md).

## 11. Liability

The Provider's total liability under this agreement and the services agreement together, for all
claims in any twelve-month period, is limited to `[amount, for example the fees paid by the School
in the preceding twelve months]`. This limit does not apply to `[list the carve-outs the parties
agree, for example: a breach caused by the Provider's wilful misconduct, or amounts a party must
pay under a regulatory penalty attributable to that party's own act]`.

Each party indemnifies the other against `[scope to be agreed]`. Penalties imposed by the Data
Protection Board on one party for that party's own failure are borne by that party.

These figures are placeholders. The parties' insurers and lawyers set them.

## 12. General

- **Governing law**: the laws of India. **Courts**: `[city]`.
- **Term**: this agreement runs for as long as the Provider processes the School's personal data.
- **Changes**: only in writing, signed by both.
- **Order of precedence**: this agreement, then the services agreement.

## Signatures

| | The School | The Provider |
|---|---|---|
| Name | `[name]` | `[name]` |
| Title | `[title]` | `[title]` |
| Date | `[date]` | `[date]` |
| Signature | | |
