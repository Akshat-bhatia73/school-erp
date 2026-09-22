# Retention schedule (template for the school)

This is a template for the school's counsel, not legal advice. It restates, in words a school can
publish, the schedule the software actually enforces. A school's own rules, or its state's
education rules, may require longer for some records; where they do, the school's rule wins and the
school should edit this page and tell us. Have it reviewed before it is published.

The engineering version, with the routes and functions that enforce each line, is
[release runbook section 6.2](../auth/RELEASE.md#62-the-retention-schedule). If the two ever
disagree, that one is what the system does.

## The rule behind the schedule

A clock starts when the reason for keeping something ends, not when it was first written down. A
pupil's three years start the day the pupil leaves, not the day the record was created.

Nothing about a person is deleted automatically. The system deletes temporary copies on its own
every night, but clearing a real pupil, guardian or staff record is always a decision someone at
the school takes, and the system refuses to do it before the period has run. That is deliberate: a
record that disappears by itself is a record nobody chose to lose.

## The schedule

| What we keep | How long | What happens at the end |
|---|---|---|
| **The admission register**: name, admission number, admission and leaving dates, class and section history, outcome | Permanently | Nothing. This is the register a school must keep. The software cannot delete these rows at all |
| **Pupil personal and sensitive details**: date of birth, Aadhaar fragment, APAAR identifier, category, religion, mother tongue, nationality, address, medical notes, reason for leaving | While enrolled, plus 3 years after leaving | The school runs the anonymisation step. The fields are cleared and cannot be recovered |
| **Pupil Aadhaar number**: the whole 12 digit number, kept encrypted, with the last four digits alongside it so a screen can name the number without showing it | The same period as the other pupil details: while enrolled, plus 3 years after leaving | The anonymisation step clears the encrypted number. The last four digits go with it |
| **Pupil photograph** | While the photographs consent stands, and no longer than the pupil period above | Withdrawing the consent removes the picture the same day, and the anonymisation step removes it in any case |
| **Guardian PAN and Aadhaar numbers**: kept encrypted, with the last four characters alongside | While any linked child is still within the pupil period | Cleared with the rest of the guardian record when the last link ends |
| **Guardian office address** | The same period as the guardian's home address | Cleared with the rest of the guardian record |
| **Staff photograph** | While employed, plus the 8 year staff period below | Removed with the rest of the private staff details |
| **Pupil documents**: certificates and uploaded files | The same 3 years | Deleted from the document store with the same step |
| **Guardian records**: name, phone, email, address, occupation, qualification, income | While any linked child is still within the period above | Anonymised when the last link ends |
| **Staff records**: salary, PAN and bank account fragments, private contact details, absence and substitution notes | While employed, plus 8 years after leaving, because payroll records must be kept | Contact details and identifiers are cleared. Employment dates and designation stay, so the school can still confirm someone worked there |
| **The fee ledger**: every receipt, refund, cancelled receipt and adjustment, with its number, date, amount by fee, how it was paid and the cheque, UPI or bank reference | 8 years after the pupil's last fee transaction, the same period as staff pay, because account books must be kept | Nothing is cleared before then. The software cannot edit or delete a ledger row at all: a correction is a new row that points at the old one |
| **The name of whoever paid**, where the office wrote one on a receipt | The same period as the other pupil details: while enrolled, plus 3 years after leaving | The anonymisation step clears the name. The money row, its number and its bank reference stay, because the accounts still have to add up |
| **A pupil's concessions and optional fees** (the bus, a sport, a club), and the category a concession was given under | With the fee ledger: 8 years after the last fee transaction | Kept with the ledger, because a balance cannot be explained without them. The reason a concession was given is never stored here: it is a note on the audit entry and can be redacted |
| **What the school charges**: its fee heads and the amount for each class and year | Permanently, as school setup. It describes the school, not a person | Nothing |
| **Logins and credentials**: password, second factor, backup codes | While the person holds an active membership at the school | Sessions end the moment the last membership is removed. The credentials themselves are deleted 30 days later. The identity's id and name are kept so old audit entries still say who did something |
| **Sign-in sessions, one-time codes, password reset links, rate-limit counters, held text messages** | Until they expire, usually minutes to days | Deleted every night |
| **Uploaded admission spreadsheets waiting to be confirmed** | 24 hours | Deleted every night, whether or not they were used |
| **Files a person exported**: a spreadsheet or document made from a list, a record or a timetable | 24 hours from the moment the file is ready | The file is deleted from the document store every night, and the record of who asked for it stays in the audit trail |
| **Invitations to join the school** | Until accepted, revoked or expired. An invitation expires 48 hours after it is sent | The email address or phone number in it is blanked at that point. The row itself is removed after 90 days |
| **Sent and failed messages**: the record that an email went out, with the address masked | 90 days | Deleted every night |
| **The audit trail**: who changed what, and who opened a sensitive record | 7 years. That covers a child's whole time at the school plus the year the law requires | Whole years are moved to cold storage. Nothing in it is ever edited |
| **A note someone typed on an audit entry** | With its entry | A person can ask for a note to be redacted. The text goes; the entry that something happened stays |
| **The request log**: one line per request to the system, holding the kind of page asked for and a scrambled form of the network address. No names, no addresses, no search terms | 180 days | Deleted every night |

## What "cleared" means

It means the field is emptied in the live database and cannot be read back. It does not mean the
row vanishes: the admission register line stays, so the school can still say that this pupil was
here in these years. A cleared record cannot be restored from a backup by us as a favour; if the
school wants a record back, it must ask in writing and we treat it as a new instruction.

## Backups

Backups are not a separate archive with its own rules. They exist to bring the system back after a
failure and they age out on their own schedule, described in `docs/auth/BACKUPS.md`. If a record is
cleared and a backup from before that day is restored, the record is cleared again as part of the
restore procedure.

## When a school leaves

The school chooses: a complete export of its records in a machine-readable file, or deletion. Both
run through the routes above rather than a one-off script, and both are confirmed in writing. The
detail is in [the data processing agreement](./DATA_PROCESSING_AGREEMENT.md) clause 10.

## Review

Review this page once a year, and whenever the school's own record-keeping rules change or the
software changes what it enforces.

| Date | Change |
|---|---|
| 19 Sep 2026 | First version, taken from release runbook section 6.2. |
| 19 Sep 2026 | Added the line for files a person exported. |
| 21 Sep 2026 | Added the fee ledger, the payer's name, concessions and optional fees, and fee setup. |
