# Security policy

This repository is a school ERP. The data it handles in production is children's
records: names, dates of birth, guardians, medical notes, documents and identity
fragments. A vulnerability here is a vulnerability in a child's privacy, so
reports are welcome and taken seriously.

## Reporting a vulnerability

Write to `<security contact address>`, or open a private security advisory through
the repository's Security tab ("Report a vulnerability"), which is the preferred
route because it keeps the report, the fix and the disclosure in one place.

Do not open a public issue or a pull request for a security problem. Do not test
against a live school. If you need an account to demonstrate something, ask and
one will be created on a test instance.

Include, as far as you can: what you did, what you saw, which URL or endpoint,
which role or account you were signed in as, and what data you were able to
reach that you should not have. A single reproducible request is worth more than
a scanner report.

## What happens next

| Step | Time |
|---|---|
| We acknowledge the report | Within `<acknowledgement target, not yet set>` |
| We assign a severity using section 2 of the incident runbook | Within one working day of acknowledging |
| We tell you what we found and whether we are fixing it | Within `<triage target, not yet set>` |
| We fix a confirmed high or critical issue, or tell you the date we will | `<fix target, not yet set>` |

One person maintains this repository today and there is no out-of-hours paging,
so a report sent at night is read in the morning. That is written down rather
than promised away.

If your report describes a live breach of real data, the clocks in
[the incident runbook](docs/compliance/INCIDENT_RESPONSE.md#5-the-two-clocks)
apply from the moment we believe it: CERT-In within six hours, the Data
Protection Board of India without delay and a full report within 72 hours, and
each affected person without delay. Your report is the moment we noticed.

## Disclosure

Tell us before you tell anyone else, and give us a chance to ship a fix. We will
credit you in the advisory unless you would rather we did not. We do not pay a
bounty today.

## Scope

In scope: this repository and any instance we run. Out of scope: reports about a
provider's own infrastructure (send those to
[the provider](docs/compliance/SUB_PROCESSORS.md)), missing headers with no
demonstrated impact, results from an automated scanner with no working request,
and denial of service through volume.

## Supported versions

There is one version: whatever is deployed from `main`. Older commits get no
fixes.

## Dependencies

Dependency advisories gate the build. `pnpm audit:deps` runs
`scripts/audit-deps.mjs`, which fails on any high or critical advisory that is
not listed in [`.audit-exceptions.json`](.audit-exceptions.json). An exception is
`{ "id", "package", "reason", "until" }`, where `id` is the numeric advisory id
or the GitHub advisory (`GHSA-...` or its URL) and `until` is the date the
exception stops being accepted. Past that date the build fails. Dependabot opens
security fixes one pull request at a time; see
[`.github/dependabot.yml`](.github/dependabot.yml).
