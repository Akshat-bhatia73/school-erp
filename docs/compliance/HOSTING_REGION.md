# Hosting region decision

Written 19 September 2026 to close the region half of finding F19 of the
[data protection assessment](DATA_PROTECTION.md). This records the decision and
the steps to carry it out. Nothing has been provisioned. Prices are list prices
read on the dates given and exclude tax.

Companion documents: [release runbook](../auth/RELEASE.md),
[incident runbook](INCIDENT_RESPONSE.md), [sub-processors](SUB_PROCESSORS.md).

## 1. What the law asks for

**CERT-In direction of 28 April 2022, direction 5.** Every service provider and
body corporate must keep system logs for 180 days **within India**. The
`access_log` table, which holds one row per `/api` request, is a system log in
that sense. Keeping it for 180 days is done; keeping it in India is not.

**DPDP Act, section 16.** Transfer of personal data outside India is allowed
unless the Central Government restricts a particular country by notification.
No notification restricts the United States today. So the database being in
Virginia is lawful under the DPDP Act as it stands, and it is the CERT-In
direction, not the Act, that the current setup fails.

Two consequences. The gap is real but narrow: it is about where logs sit, not
about a prohibited transfer. And it can change: a sectoral rule, a state
education department tender, or a school's own procurement policy can require
Indian hosting even where the Act does not.

## 2. Where things are today

| Piece | Where | How this was established |
|---|---|---|
| Site and API function | Vercel, `iad1` (us-east-1, Washington D.C.) | The root `vercel.json` sets no `regions` key, and Vercel Functions default to `iad1` for all new projects ([Vercel docs, regions](https://vercel.com/docs/regions), read 19 September 2026) |
| PostgreSQL, including `access_log` and `audit_events` | Neon, AWS `us-east-1` | Section 0 of the release runbook; the Neon project was created through the Vercel Marketplace |
| Private documents | Vercel Blob | Region follows the Blob store, see `SUB_PROCESSORS.md` |
| Error reports | Sentry | Region follows the Sentry organisation, see `SUB_PROCESSORS.md` |

Neon has no Indian region. Its supported regions are AWS `us-east-1`,
`us-east-2`, `us-west-2`, `eu-central-1`, `eu-west-2`, `ap-southeast-1`,
`ap-southeast-2` and `sa-east-1`, plus three deprecated Azure regions
([Neon docs, regions](https://neon.com/docs/introduction/regions), read
19 September 2026). The nearest region to India is Singapore. Singapore is not
India, so moving to it would improve latency and change nothing legally.

Vercel does have Mumbai: `bom1`, AWS `ap-south-1`
([Vercel docs, regions](https://vercel.com/docs/regions), read 19 September
2026). Hobby allows a single function region, so `bom1` can be set today at no
cost. Moving the function alone does not help the log requirement, because the
log rows live in the database, but it removes a second-country hop once the
database moves and it is the cheap half of the change.

## 3. Options

Rough monthly cost for one small school: a database under 10 GB with a few
hundred daily users.

### A. Supabase, `ap-south-1` Mumbai

Managed PostgreSQL with Mumbai in the supported region list
([Supabase docs, regions](https://supabase.com/docs/guides/platform/regions),
read 19 September 2026). Pro is $25 per month per organisation, which includes
8 GB of database storage, 250 GB egress, daily backups and a $10 monthly
compute credit ([Supabase pricing](https://supabase.com/pricing), read
19 September 2026). Compute is billed per project on top: Micro is about $10 per
month (shared CPU, 1 GB memory, up to about 10 GB database) and Small about $15
([Supabase compute and disk](https://supabase.com/docs/guides/platform/compute-and-disk),
read 19 September 2026). With the credit, Pro plus a Micro instance is about
**$25 per month**, and Pro plus Small about **$30**. The free tier has Mumbai
too but pauses a project after a week of inactivity and holds 500 MB, so it is
a test database, not a school's.

### B. AWS RDS for PostgreSQL, `ap-south-1` Mumbai

Plain managed PostgreSQL, no extra product surface. On-demand single-AZ in
Mumbai is $0.021 per hour for `db.t4g.micro` and $0.042 for `db.t4g.small`, and
gp3 storage is $0.131 per GB-month (AWS Price List API, offer file
`https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonRDS/current/ap-south-1/index.json`,
read 19 September 2026; the same numbers appear on
<https://aws.amazon.com/rds/postgresql/pricing/> after selecting Mumbai).
At 730 hours that is about **$18 per month** for `db.t4g.micro` with 20 GB of
storage, or about **$33** for `db.t4g.small`. Single-AZ, so a zone failure is an
outage. Multi-AZ roughly doubles the instance cost. This price excludes
backup storage beyond the free allowance and data transfer, and it excludes the
time to run it: security groups, parameter groups, minor-version upgrades,
certificate rotation and monitoring are all ours.

### C. Aiven for PostgreSQL, AWS Mumbai

Aiven lists `aws-ap-south-1`, "Asia, India: Mumbai", as an available cloud
([Aiven list of clouds](https://aiven.io/docs/platform/reference/list_of_clouds),
read 19 September 2026). Plan prices start at $12 per month for Hobbyist and
$75 per month for Startup ([Aiven pricing](https://aiven.io/pricing), read
19 September 2026), but Hobbyist is only offered on DigitalOcean, Google Cloud
and OVH, so the smallest Mumbai plan is a Startup one. The exact Mumbai figure
is <Aiven Startup-4 monthly price on aws-ap-south-1, from the Aiven pricing
calculator> — the public pricing page shows a "starting from" number for
DigitalOcean and does not break out AWS Mumbai. Call it **$75 or more per
month** until that is confirmed. What the money buys over B is backups,
failover, upgrades and support handled by the vendor.

### D. Stay on Neon and accept the gap until a real school signs

Cost **$0**. The gap is already written down in three places (release runbook
6.3, incident runbook section 9, finding F19) and the rule today is that no
school outside the internal test group is onboarded, and any school that is must
be told where its data sits. Nothing breaks. The risk is that the decision gets
made under time pressure during a school's procurement, which is when a
migration is hardest to schedule.

## 4. What each option changes

Mostly the same things, because all four are PostgreSQL 16 with the same schema.

**Row-level security is unaffected.** Forced RLS, the policies and
`withTenantTransaction` are plain PostgreSQL. They behave identically on any of
these. This is the largest single reason the move is cheap.

**The four logins have to be recreated.** `erp_runtime`, `erp_auth`,
`erp_identity` and the migrator are created by SQL, not by the provider, so
`packages/db/docker-init/00-roles.sql` plus the grants in the migrations are
the recipe anywhere. Two details differ by provider:

- Neon's `neondb_owner` is the migrator and is not a superuser, which is why
  migrations 0002 and 0004 need the two extra grants described in release
  runbook section 0.1. On RDS the `rds_superuser` master user has the same
  shape of limitation; on Supabase the `postgres` role does. Expect to keep
  those grants, not drop them.
- None of the four logins may hold `BYPASSRLS`. Check it after the restore, not
  before.

**Connection pooling changes.** The API is a Vercel Function using `pg` pools,
so each warm instance holds real backends. Neon gives a pooler endpoint
(PgBouncer) as a separate host. Supabase gives Supavisor, also a separate host
and port, with transaction mode. RDS needs RDS Proxy, which is an extra charge
of about `<RDS Proxy price per vCPU-hour in ap-south-1>`, or a self-run PgBouncer,
or the acceptance that `max_connections` on a `t4g.micro` is small. Aiven
bundles PgBouncer per service. Whatever is chosen: the four URLs must all point
at the pooler in transaction mode, and `SET LOCAL` inside an explicit
transaction — which is how the tenant context is set — is safe in transaction
mode. Session-level features are not used.

**The evidence queries in the incident runbook keep working**, because they are
plain SQL against `access_log` and `audit_events` with the migrator login. What
changes is where `MIGRATION_DATABASE_URL` points and, on Supabase and Aiven,
whether the console offers a SQL editor that would let someone read the log
without the recorded procedure. If it does, the rule in incident runbook section
6 — one permitted direct read, recorded in the incident record — has to cover
console access too, and console access should be limited to the same person.

**Backups change hands.** Neon's restore window is a branch at a point in time.
Supabase Pro does daily backups; RDS does automated backups with a retention
window you set; Aiven does continuous backup. The rehearsal procedure in
`docs/auth/BACKUPS.md` has to be rewritten for whichever is chosen, because
"create a branch at a timestamp" is a Neon idea.

**Scale to zero goes away** on B and C. Neon suspends idle compute, which is why
the first request after a quiet spell is slow and why the free tier costs
nothing. An RDS or Aiven instance runs and bills all month.

## 5. Recommendation

**Take D now and A when the first school signs, and set the function region to
`bom1` at the same time as A.**

The reasons, in order:

1. The CERT-In gap is a documented gap with no school's children in the
   database. Paying $25 a month now to fix a paper finding for a database of
   invented people is the wrong spend. What matters is that the decision is
   taken, not that it is executed today.
2. Of the three Indian options, Supabase is the cheapest that is still managed,
   and it is the closest in shape to Neon: managed PostgreSQL, a pooler in front,
   a branch-like preview database, backups done for us. The migration is a dump
   and a restore plus four `CREATE ROLE` statements.
3. AWS RDS is cheaper on paper at `db.t4g.micro` and more expensive in reality,
   because patching, backups, monitoring and a proxy are then our job and there
   is one person. Choose it only if a school's procurement requires the data to
   sit in an account the school can audit.
4. Aiven is the better answer at the point where there are several schools and
   an uptime commitment, and is at least three times the price for the first
   one.
5. `bom1` is free and belongs with the database move, not before it: with the
   database in `us-east-1`, a Mumbai function would add a round trip from India
   to Virginia to every query.

The trigger to execute is a signed school, or any tender or policy that names
Indian hosting, whichever comes first. Until then the gap statements in the
release runbook, the incident runbook and F19 stay as they are, and every
prospective school is told in writing where its data would sit.

## 6. Migration steps

For option A. Steps 1 to 4 are rehearsable against a scratch project before the
real run. Expect a maintenance window: the application is offline from step 3
to step 8, which for a small school's data should be under an hour.

1. Create the Supabase project in `ap-south-1`, choose the compute size, and
   record the project reference, the direct host and the Supavisor host and
   port. Put the region and the date in `SUB_PROCESSORS.md`.
2. Take a schema-and-data dump from Neon with the migrator login:
   `pg_dump "$MIGRATION_DATABASE_URL" --no-owner --no-privileges --format=custom
   --file=erp-`<date>`.dump`. `--no-owner` and `--no-privileges` matter: the
   ownership and grants are recreated by the roles file and the migrations, not
   copied. Keep the dump encrypted and delete it when step 9 passes.
3. Put the application into maintenance (remove the production deployment's
   database URLs or set the project to a maintenance rewrite), so nothing writes
   to Neon after the dump.
4. Take a second, final dump the same way. The first one proved the procedure;
   this one is the data.
5. Create the four logins on the new database: run the equivalent of
   `packages/db/docker-init/00-roles.sql` with production passwords from the
   secret store, not the development ones in that file, then
   `pnpm db:migrate` with `MIGRATION_DATABASE_URL` pointed at the new database
   so the schema, the RLS policies, the grants and the two function grants are
   applied by the migrations rather than by the restore.
6. Restore the data:
   `pg_restore --data-only --disable-triggers --dbname="$MIGRATION_DATABASE_URL"
   erp-`<date>`.dump`. Then check: every migration row present, every tenant table
   `FORCE ROW LEVEL SECURITY`, the four logins present, none of them with
   `BYPASSRLS`, and the row counts matching the source. `scripts/restore-rehearsal.mjs`
   from `docs/auth/BACKUPS.md` does exactly these checks; use it and paste the
   output into `docs/compliance/RESTORE_LOG.md`.
7. Re-point the Vercel environment variables for Production: `DATABASE_URL`
   (`erp_runtime`), `AUTH_DATABASE_URL` (`erp_auth`), `IDENTITY_DATABASE_URL`
   (`erp_identity`), all three at the pooler host in transaction mode, and
   `MIGRATION_DATABASE_URL` in the deploy environment only, at the direct host.
   Startup refuses a migrator URL in the runtime, so a mistake here fails loudly.
8. Add `"regions": ["bom1"]` at the top level of `vercel.json` and deploy. Hobby
   allows one region, so this is a single-element array. Confirm the deployment
   summary shows Mumbai.
9. Re-run the release checklist in `docs/auth/RELEASE.md` section 10 end to end
   against the new deployment. Items 4 (least-privilege logins), 9 (backups and
   a rehearsed restore) and 15 are the ones this change touches, but the whole
   list is short and a region move is exactly when an assumption breaks.
10. Update `SUB_PROCESSORS.md` (Neon out or demoted, Supabase in, with region,
    purpose, data and the date checked) and `INCIDENT_RESPONSE.md` (section 9
    loses the region gap; section 6 gains whatever the new console allows).
    Update release runbook sections 0, 5 and 6.3, `docs/auth/BACKUPS.md`, and
    finding F19 in `DATA_PROTECTION.md`.
11. Keep the Neon project read-only for `<number>` days as a fallback, then delete
    it and record the deletion. A forgotten copy of a school's data in Virginia
    is worse than never having moved.

## 7. Open items

- The Aiven Mumbai price for the smallest AWS plan, and the RDS Proxy price in
  `ap-south-1`. Both need a vendor calculator; neither changes the
  recommendation.
- Vercel Blob and Sentry regions are not decided here. The access log is the
  CERT-In question and it lives in PostgreSQL, but private documents and error
  reports also leave India. `SUB_PROCESSORS.md` records where they sit; whether
  they must move is a second decision.
- Nobody has checked whether a Vercel Hobby project may be used for a paying
  school at all. That is a licensing question for the same moment as this
  migration.
