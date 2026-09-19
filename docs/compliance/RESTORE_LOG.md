# Restore log

Every restore rehearsal and every real restore, newest first. This file is the
evidence for item 9 of [the release checklist](../auth/RELEASE.md#10-release-checklist)
and for the Availability criterion in
[the data protection assessment](./DATA_PROTECTION.md#8-soc-2-readiness-map).

How to produce an entry is in [docs/auth/BACKUPS.md](../auth/BACKUPS.md)
section 5. Paste the output of `node scripts/restore-rehearsal.mjs` as it comes,
then fill in the lines around it. Do not edit a past entry; add a new one.

A rehearsal counts only if the checker passed **and** a person signed in to a
copy of the API pointed at the restored database and opened one student.

## Template

```markdown
### Rehearsal YYYY-MM-DD

- Kind: rehearsal | real restore
- Source: Neon history window at <RFC 3339 timestamp> | weekly dump <file name>
- Target: Neon branch <name> | scratch database <name>
- Started: <HH:MM IST>   Restore usable: <HH:MM IST>   Elapsed: <minutes>
- Data loss if this had been production: <duration between source and now>
- Encryption key version in force when the source was taken: <version>
- Performed by: <name>
- Application check: signed in and opened student <admission number> — yes | no
- Outcome: passed | failed
- Follow-ups: <ticket or none>

<paste the checker output here, both tables and the closing line>

- Branch or scratch database deleted afterwards: yes | no
```

## Entries

### Operations note 19 September 2026

Not a restore. Migrations `0009_data_lifecycle.sql` and `0010_observability.sql`
were applied to the production Neon database by hand, because the migrator there
(`neondb_owner`) has `CREATEROLE` but is not a superuser and both migrations
transfer ownership of SECURITY DEFINER functions to `erp_maintenance`. The run
failed twice, first with "must be able to SET ROLE erp_maintenance" and then with
"permission denied for schema public". It was completed with temporary grants
issued as the database owner:

```sql
GRANT erp_maintenance TO neondb_owner;
GRANT USAGE, CREATE ON SCHEMA public TO erp_maintenance;
-- migrations run here
REVOKE CREATE ON SCHEMA public FROM erp_maintenance;
```

No data was read, changed or exported. The same grants are now part of the
migration set (`0001_z_migrator_role_bootstrap.sql` and
`0011_revoke_bootstrap_create.sql`), so a from-empty run by a non-superuser
migrator needs no hand work; see [DATABASE.md](../auth/DATABASE.md).

### 2026-09-19 — no rehearsal has been performed

No restore of this system has ever been rehearsed, and no weekly dump has ever
been taken. The only backup that exists is Neon's six-hour history window on the
Free plan.

The procedure and both scripts landed on 19 September 2026 in Task 14 and were
tested end to end against a local disposable database
(`erp_test_backup`, prepared with `pnpm db:test:prepare`), which proves the
checker works but proves nothing about production. That run reported: all 11
migrations applied, 34 tenant tables with row level security forced, the four
logins present, and zero rows in every counted table, as expected for a freshly
migrated empty database.

Release checklist item 9 cannot be ticked until an entry above this one says
`Outcome: passed` against the production database.
