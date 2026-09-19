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
