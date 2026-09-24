# Sub-processors

This is a template for the school's counsel, not legal advice. It lists every third party that
holds or handles personal data on our behalf when the school uses this platform. A school may
publish it, attach it to the data processing agreement, or ask counsel to rewrite it. Nobody here
is a lawyer. Have it reviewed before it is signed or published.

Last checked: 19 September 2026. Sources are cited with the date each page was read.

## 1. How to read this list

A sub-processor is a company we use that can, in the course of doing its job, hold or see personal
data belonging to the school's pupils, parents or staff. "Region" is where the data physically
sits, as far as we can establish from the provider's own documentation and our own configuration.
Where we could not establish it, the cell says so in square brackets instead of guessing.

The four data categories used below match [the data protection assessment](./DATA_PROTECTION.md)
section 3:

- **School records**: pupil, guardian and staff records, including sensitive fields.
- **Documents**: files uploaded against a pupil, such as certificates.
- **Contact data**: an email address and the text of a message sent to it.
- **Technical data**: error reports, request metadata, uptime checks. No names.

## 2. The list

| Provider | What it does for us | Personal data it holds | Region | Checked |
|---|---|---|---|---|
| Neon (Neon Inc.) | The PostgreSQL database. This is the system of record. | School records, audit events, access log, login credentials | AWS `us-east-1` (N. Virginia, USA). Recorded in [the incident runbook](./INCIDENT_RESPONSE.md) section 9 and [the release runbook](../auth/RELEASE.md#63-the-access-log) | 19 Sep 2026 |
| Vercel (Vercel Inc.) | Hosts the website and the one API function; also hosts the private document store (Vercel Blob). | School records in transit through the function; documents at rest in the Blob store | Function: `iad1` (Washington DC, USA). `vercel.json` in this repository sets no `regions` key, and Vercel's default function region for all new projects is `iad1`, so that is where the API runs. Blob store: `[region chosen when the store was created — read it in the Vercel dashboard under Storage, or `vercel blob store get`; it cannot be changed after creation]` | 19 Sep 2026 |
| Resend (Resend Inc.) | Sends email: invitations, one-time codes, password resets, and the school's messages to families and staff (Task 22), with their attached files. | Contact data: the recipient address and the message body. A school message's body and files are about children: absence, results, fees, birthdays and the school's notices | Account data, email metadata and logs are stored in the United States whatever sending region is chosen. Our sending region is `[read it in the Resend dashboard under the domain's settings; existing domains default to us-east-1, North Virginia]` | 19 Sep 2026 |
| Sentry (Functional Software, Inc.) | Error reports and the repeated-denial alert. | Technical data only. The API sends no request bodies, cookies, headers, query strings, users or breadcrumbs ([release runbook](../auth/RELEASE.md#2-environment-variables)) | The organisation's storage location is either the US (Iowa) or the EU (Frankfurt), fixed when the organisation was created. Ours is `[read it in Sentry under Organization Settings; it cannot be changed without creating a new organisation]` | 19 Sep 2026 |
| Better Stack (Better Stack, Inc.) | Uptime checks against the public health route. | None of the school's. The health route returns no personal data and writes no access-log row. Better Stack holds only our own account and the check results | Better Stack stores data in EU regions by default and offers custom locations for enterprise accounts. Ours is the default unless changed: `[confirm in the Better Stack dashboard]` | 19 Sep 2026 |
| GitHub (GitHub, Inc., a Microsoft company) | Source code, issues and CI. | None of the school's. No school data, no database dump and no export is ever stored in the repository or as a CI artifact ([the backup rules](../auth/BACKUPS.md)) | USA | 19 Sep 2026 |

## 3. Sources

- Vercel, "Configuring regions for Vercel Functions": the default function region is Washington DC
  (`iad1`) for all new projects. <https://vercel.com/docs/functions/configuring-functions/region>,
  read 19 September 2026.
- Vercel, "Vercel Blob": stores can be created in any of 20 regions, the region is chosen at
  creation and cannot be changed, and the underlying storage is Amazon S3.
  <https://vercel.com/docs/vercel-blob>, read 19 September 2026.
- Resend, "Choosing a Region": "All account data, including email metadata, logs, and API records,
  is stored in the United States regardless of the sending region you select."
  <https://resend.com/docs/dashboard/domains/regions>, read 19 September 2026.
- Sentry, "Data Storage Location": US (Iowa) or EU (Frankfurt), chosen at organisation setup and
  not changeable afterwards; some account metadata may sit in the US either way.
  <https://docs.sentry.io/organization/data-storage-location/>, read 19 September 2026.
- Better Stack, "Security and Compliance": "by default, all data is stored in the EU regions in
  GDPR-compliant DIN ISO/IEC 27001-certified data centers", with custom locations for enterprise
  accounts. <https://betterstack.com/security>, read 19 September 2026.
- Neon region: taken from the deployment, not from documentation. It is written in
  [the incident runbook](./INCIDENT_RESPONSE.md) section 9.

## 4. How to check the regions yourself

- **Vercel function region.** `vercel project inspect <project>` prints the project's settings,
  including the function regions; the dashboard shows the same under Settings, Functions. If
  `vercel.json` gains a `regions` key it wins over the project default, so check the file too.
- **Vercel Blob region.** The store's page in the dashboard under Storage, or `vercel blob store
  get`. It is fixed at creation.
- **Neon region.** The project's page in the Neon console, or the host name in
  `MIGRATION_DATABASE_URL`.
- **Resend sending region.** The domain's page in the Resend dashboard. It changes where mail is
  sent from, not where the logs are stored.
- **Sentry region.** Organization Settings in Sentry, or the region prefix in the ingest host of
  `SENTRY_DSN`.

## 5. Changes

We tell the school before a new sub-processor starts handling its data, and give it time to
object. The notice period and what happens on an objection are in
[the data processing agreement](./DATA_PROCESSING_AGREEMENT.md) clause 6.

| Date | Change |
|---|---|
| 19 Sep 2026 | First version of this list. |
| 21 Sep 2026 | Fees module added. No new sub-processor: fee records sit in the same database, and a receipt or a fee list made as a file sits in the same document store for 24 hours. There is no payment gateway, so no payment company receives anything. Choosing one is a decision still to take, and it would add a row here before it is switched on. |

## 6. Known gap

None of the data above sits in India. The CERT-In requirement to keep system logs in India for 180
days is therefore not met. This is written down, not hidden: see
[the hosting region decision](./HOSTING_REGION.md) and
[the incident runbook](./INCIDENT_RESPONSE.md) section 9. A school must be told where its data sits
before it signs.
