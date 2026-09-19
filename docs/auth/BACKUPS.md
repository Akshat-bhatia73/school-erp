# Backups and restore

A backup nobody has restored is not a backup. This document says what exists
today, what is only written down, and how to prove the difference.

Added in Task 14 to close finding F17 of
[the data protection assessment](../compliance/DATA_PROTECTION.md).

## 1. Where we stand

| Layer | State today |
|---|---|
| Neon's own history window | Live. Six hours on the Free plan. This is the only backup that exists right now |
| Weekly encrypted dump to an Indian-region bucket | Scripted (`scripts/backup-dump.sh`) and documented here, not scheduled. There is no bucket yet |
| Restore rehearsal | Scripted (`scripts/restore-rehearsal.mjs`). Never performed against production. See [RESTORE_LOG.md](../compliance/RESTORE_LOG.md) |

Read that table as it is written. If the Neon project were deleted this morning,
anything older than six hours would be gone.

The weekly dump is deliberately not scheduled yet. It needs an object store in
an Indian region and a key holder, and the free tier has neither. The decision
in Task 14 was to write and test the procedure now and turn it on when a real
school signs, rather than pretend a job exists.

## 2. What Neon keeps

Neon calls point-in-time restore *instant restore*, and the amount of change
history it keeps the *history window*. The history is Write-Ahead Log records,
not snapshots, so a restore is a new branch at a chosen moment rather than a
file to copy back.

| Plan | Default history window | Maximum | Cost of the history |
|---|---|---|---|
| Free | 6 hours | 6 hours, capped at 1 GB-month | Included |
| Launch | 1 day | 7 days | $0.20 per GB-month |
| Scale | 1 day | 30 days | $0.20 per GB-month |

Sources, both read on 19 September 2026:
<https://neon.com/docs/postgres/backup-restore/history-window> and
<https://neon.com/docs/introduction/plans>. The restore procedure is from
<https://neon.com/docs/introduction/branch-restore>, also read on
19 September 2026.

Two limits worth knowing before an incident:

- **Instant restore works on root branches only.** A child branch cannot be
  restored to an earlier moment. The production database is the root branch, so
  this is fine, but it means the test branch is not itself protected.
- **Six hours is short.** A bad migration or a wrong `DELETE` noticed the next
  morning is outside the window on the Free plan. Moving to Launch and setting
  the window to seven days is the single cheapest improvement available, and is
  the recommendation in section 8.

The Neon project region is `us-east-1`. That is a separate problem from backups
and is decided in [HOSTING_REGION.md](../compliance/HOSTING_REGION.md).

## 3. Restoring to a point in time

This is the fast path, and the one to use during an incident. It creates a new
branch holding the database as it was at a chosen moment. Production is not
touched, so it is safe to do while deciding what to do.

1. Fix the moment. From the incident record, the last timestamp before the
   damage, in UTC, RFC 3339: `2026-09-19T04:15:00Z`.
2. Create the branch:

   ```bash
   neon branches create --name restore-20260919 --parent 2026-09-19T04:15:00Z
   ```

   The same thing is available in the console under **Backup & Restore** on the
   branch, and through `POST /projects/{project_id}/branches/{branch_id}/restore`.
3. Get a connection string for it. Ask for the migrator login, not a runtime
   login, because the checker reads catalogue tables:

   ```bash
   neon connection-string restore-20260919
   ```

4. Check it before trusting it:

   ```bash
   node scripts/restore-rehearsal.mjs "<connection string>"
   ```

5. Decide what to do with it. There are three ways forward and they are not
   equally reversible:
   - **Read from it.** Point nothing at it; query it with the migrator login to
     recover the rows that were lost, and copy them back by hand. Right answer
     for "one class was deleted".
   - **Promote it.** `neon branches set-default restore-20260919` makes it the
     branch the connection strings resolve to. Everything written to production
     since the chosen moment is then no longer live. Right answer only when the
     damage is total.
   - **Copy it.** Dump the branch and restore the pieces you want into
     production. Slowest, least destructive.

   Whichever you choose, write the branch name, the timestamp and the decision
   into the incident record. The branch counts against project storage: delete
   it when the incident is closed.

Restoring never recreates the four logins. `erp_runtime`, `erp_auth`,
`erp_identity` and `erp_maintenance` are roles at the Neon project level, not
inside the database, so a branch of the same project already has them. A restore
into a *different* Neon project or another provider does not; see section 7.

## 4. The weekly dump

`scripts/backup-dump.sh`. Run it from a machine you control, weekly, and record
the result. It never runs in CI: a `pg_dump` kept as a GitHub Actions artifact is
a complete copy of children's records sitting in a third-party store with a
default 90-day retention, readable by anyone who can read the repository. That
was the specific thing F17 objected to.

`pg_dump` must be the same major version as the server. The project runs
PostgreSQL 18 (`compose.db.yml` and `.github/workflows/ci.yml` pin
`postgres:18.x`), so use `pg_dump` 18 and check with `pg_dump --version` before
you trust a dump. An older `pg_dump` refuses to run against a newer server, and
a newer one writes an archive the server's `pg_restore` cannot read.

What it does, in order: `pg_dump --format=custom --no-owner --no-privileges`
using the migrator login into a `mktemp -d` directory with mode 700; encrypts it
with `age` to the recipients in a key file; shreds the plaintext; uploads the
encrypted file to `s3://<bucket>/postgres/erp-<timestamp>.dump.age` in
`ap-south-1` with server-side encryption on; prints the size and the SHA-256.

What you need before it can run:

| Thing | Value |
|---|---|
| Bucket | `<bucket name>`, region `ap-south-1`, versioning on, public access blocked, lifecycle rule deleting objects after `<retention>` days |
| Writer credentials | An IAM principal that can `PutObject` and nothing else. It must not be able to read or delete |
| Age recipients file | `<path>`, holding the public keys of `<key holders>` |
| Age private keys | Held offline by those people, never in the repository, never in Vercel, never in a password manager shared with the application |

Every one of those is a placeholder because none of them exist yet.

A dump holds the APAAR ciphertext but not `DATA_ENCRYPTION_KEY`. Restoring a
dump without the key of the day it was taken leaves those fields unreadable.
Keep a note of which key version was current in the restore log, and read
[the incident runbook](../compliance/INCIDENT_RESPONSE.md) before rotating that
key.

Restoring a dump:

```bash
age --decrypt --identity <key file> --output dump.pgdump erp-<timestamp>.dump.age
createdb erp_restore
pg_restore --dbname=erp_restore --no-owner --no-privileges dump.pgdump
node scripts/restore-rehearsal.mjs "postgres://.../erp_restore"
```

## 5. The quarterly rehearsal

Once before go-live, then once a quarter. It takes about half an hour.

1. Pick a moment inside the history window, or the newest weekly dump.
2. Restore it by section 3 or section 4.
3. Run the checker:

   ```bash
   node scripts/restore-rehearsal.mjs "<connection string>"
   ```

   It checks that every file in `packages/db/migrations` is recorded as applied
   with a matching checksum, that every table carrying a `school_id` forces row
   level security (`access_log` excepted, it is global infrastructure), that the
   four logins exist, and it prints row counts for the main tables. It prints
   Markdown, and it never prints the connection string, so the output can be
   pasted into the log as it stands. Exit code 0 means every check passed, 1
   means a check failed, 2 means it could not run.
4. Sign in to a copy of the API pointed at the restored database and open one
   student. A green checker with a broken application is still a failed
   rehearsal.
5. Paste the output into [RESTORE_LOG.md](../compliance/RESTORE_LOG.md), add the
   wall-clock time the restore took and who did it, and delete the branch or the
   scratch database.

If the checker fails, the rehearsal failed. Do not tick checklist item 9.

## 6. If the primary is lost

Losing the primary means the Neon project is gone or unreachable, not that one
query is slow.

1. Put the site into a state that does not lie. The API returns errors when the
   database is unreachable; that is correct. Do not point it at a half-restored
   database.
2. Decide which source is newer: the Neon history window (nothing if the project
   itself is gone) or the newest weekly dump.
3. Create the target. A new Neon project, or PostgreSQL elsewhere. The
   migrator login (`erp_migrator` locally) comes with the server.
4. Create the three application logins first, with fresh passwords:
   `erp_runtime`, `erp_auth` and `erp_identity`. Nothing in a dump carries a
   password, and the migrations grant to these roles, so they have to exist
   before the migrations run.
   `packages/db/docker-init/00-roles.sql` is the local-development version of
   this step and shows the exact attributes each login needs
   (`LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`, plus
   `GRANT CONNECT ON DATABASE`). In production these credentials come from the
   secret manager, not from that file. See [DATABASE.md](./DATABASE.md).
   Migration `0000_auth_rbac.sql` does contain `DO` blocks that create
   `erp_runtime`, `erp_auth` and `erp_identity` idempotently, but only as
   `NOLOGIN` roles, so a database whose roles came only from the migrations
   cannot be connected to by the application. `erp_maintenance` is different:
   migration `0009_data_lifecycle.sql` creates it, it is `NOLOGIN` by design and
   nothing ever logs in as it, so there is nothing to create by hand.
5. Apply the migrations: `MIGRATION_DATABASE_URL=... pnpm db:migrate`. This
   creates the schema, the row level security, the functions, the
   `erp_maintenance` role, and the grants to the logins from step 4.
6. Restore the data with `pg_restore --data-only` if the schema came from the
   migrations, or restore the whole dump into an empty database and then check
   the migration table matches.
7. Run `node scripts/restore-rehearsal.mjs`. It checks that all four roles
   (`erp_runtime`, `erp_auth`, `erp_identity`, `erp_maintenance`) exist.
8. Re-point `DATABASE_URL`, `AUTH_DATABASE_URL` and `IDENTITY_DATABASE_URL` in
   Vercel and redeploy.
9. Work section 10 of [RELEASE.md](./RELEASE.md) from the top. A restore is a
   release.
10. Write it up. A restore under pressure is an incident; it belongs in the
    incident record and in the restore log.

Expect this to take hours, not minutes, and expect data loss up to the age of
the newest source. Say that number out loud to the school.

## 7. What is not backed up

- **Private documents in Blob storage.** `files/blob.ts` puts student documents
  in Vercel Blob. Nothing copies them anywhere. A restored database will point
  at files that may no longer exist. Open.
- **Secrets.** `AUTH_SECRET`, `DATA_ENCRYPTION_KEY`, provider keys and the four
  database passwords live in Vercel's environment settings and nowhere else. If
  that account is lost, `DATA_ENCRYPTION_KEY` is lost with it, and the sealed
  APAAR fields can never be opened again. There is no key escrow. Open.
- **The audit archive.** The retention schedule says whole years of
  `audit_events` are archived to cold storage after seven years. No archive
  exists yet, so those rows only live in the database.

## 8. Recommendation

Cheapest first, in the order they should be done:

1. Move the Neon project to Launch and set the history window to seven days.
   One bad morning is currently unrecoverable.
2. Create the `ap-south-1` bucket and the age keys, and put the weekly dump on a
   calendar. The script is ready.
3. Rehearse once, before the first school's data is in the system, and write the
   first real entry in the restore log.
4. Decide what happens to Blob documents and to the secrets in section 7.
