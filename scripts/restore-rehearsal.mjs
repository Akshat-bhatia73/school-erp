#!/usr/bin/env node
// Checks a restored database and prints a block to paste into
// docs/compliance/RESTORE_LOG.md.
//
//   node scripts/restore-rehearsal.mjs "postgres://erp_migrator:...@host/db"
//   RESTORE_CHECK_URL=... node scripts/restore-rehearsal.mjs
//
// Connect with the migrator login: the checks read catalogue tables and count
// rows, which the runtime logins are not allowed to do.
//
// This script never prints the connection string, not even on failure. Keep it
// that way: the output is pasted into a file that is committed.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dbPackage = join(here, "..", "packages", "db", "package.json");
const migrationsDirectory = join(here, "..", "packages", "db", "migrations");
// pg is a dependency of @erp/db, not of the repository root, so resolve it
// from there rather than adding a root dependency for one script.
const pg = createRequire(pathToFileURL(dbPackage))("pg");

const connectionString = process.argv[2] ?? process.env.RESTORE_CHECK_URL;
if (!connectionString) {
  console.error(
    "Give the connection string as the one argument, or set RESTORE_CHECK_URL.",
  );
  process.exit(2);
}

const EXPECTED_ROLES = [
  "erp_runtime",
  "erp_auth",
  "erp_identity",
  "erp_maintenance",
];
// access_log is global infrastructure, not owned by a school; it carries a
// school_id for reading but has no row level security by design.
const RLS_EXEMPT = ["access_log"];
const COUNTED_TABLES = [
  "schools",
  "school_memberships",
  "students",
  "guardians",
  "staff",
  "audit_events",
  "guardian_consents",
];

/** One line of the report. */
const results = [];
const notes = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
}

const pool = new pg.Pool({ connectionString, max: 1 });
let counts = [];
try {
  // 1. Every migration on disk is recorded as applied, with the same checksum.
  // migrate.mjs tracks them in erp_schema_migrations(name, checksum).
  const onDisk = (await readdir(migrationsDirectory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const table = await pool.query(
    "SELECT to_regclass('public.erp_schema_migrations') AS present",
  );
  if (!table.rows[0].present) {
    record("Migrations applied", false, "erp_schema_migrations is missing");
  } else {
    const applied = new Map(
      (
        await pool.query("SELECT name, checksum FROM erp_schema_migrations")
      ).rows.map((row) => [row.name, row.checksum]),
    );
    const missing = [];
    const changed = [];
    for (const name of onDisk) {
      const checksum = createHash("sha256")
        .update(await readFile(join(migrationsDirectory, name), "utf8"))
        .digest("hex");
      if (!applied.has(name)) missing.push(name);
      else if (applied.get(name) !== checksum) changed.push(name);
    }
    const problems = [
      ...missing.map((name) => `not applied: ${name}`),
      ...changed.map((name) => `checksum differs: ${name}`),
    ];
    record(
      "Migrations applied",
      problems.length === 0,
      problems.length === 0
        ? `all ${onDisk.length} applied, newest ${onDisk.at(-1)}`
        : problems.join("; "),
    );
  }

  // 2. Every table with a school_id column forces row level security.
  const rls = await pool.query(
    `SELECT c.relname AS table_name, c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND EXISTS (
          SELECT 1 FROM pg_attribute a
           WHERE a.attrelid = c.oid
             AND a.attname = 'school_id'
             AND a.attnum > 0
             AND NOT a.attisdropped)
      ORDER BY c.relname`,
  );
  const tenantTables = rls.rows.filter(
    (row) => !RLS_EXEMPT.includes(row.table_name),
  );
  const unforced = tenantTables
    .filter((row) => !row.relforcerowsecurity)
    .map((row) => row.table_name);
  record(
    "Row level security forced",
    tenantTables.length > 0 && unforced.length === 0,
    tenantTables.length === 0
      ? "no tenant tables found, which is wrong"
      : unforced.length === 0
        ? `${tenantTables.length} tenant tables, all forced (${RLS_EXEMPT.join(", ")} exempt by design)`
        : `not forced: ${unforced.join(", ")}`,
  );

  // 3. The four least-privilege logins exist.
  const roles = await pool.query(
    "SELECT rolname FROM pg_roles WHERE rolname = ANY($1)",
    [EXPECTED_ROLES],
  );
  const present = new Set(roles.rows.map((row) => row.rolname));
  const absent = EXPECTED_ROLES.filter((role) => !present.has(role));
  record(
    "Roles exist",
    absent.length === 0,
    absent.length === 0
      ? EXPECTED_ROLES.join(", ")
      : `missing: ${absent.join(", ")}`,
  );

  // 4. Row counts for the main tables. Forced row level security applies to
  // the table owner too, so a login that neither bypasses it nor sets a tenant
  // context would count zero rows everywhere. Say so rather than report zeros.
  const bypass = await pool.query(
    "SELECT rolsuper OR rolbypassrls AS ok FROM pg_roles WHERE rolname = current_user",
  );
  if (!bypass.rows[0]?.ok)
    notes.push(
      "The login used does not bypass row level security, so the row counts " +
        "below are what that login can see, not what the database holds. " +
        "Re-run with the login that owns the schema.",
    );

  for (const name of COUNTED_TABLES) {
    const exists = await pool.query("SELECT to_regclass($1) AS present", [
      `public.${name}`,
    ]);
    if (!exists.rows[0].present) {
      counts.push({ name, count: "table missing" });
      continue;
    }
    const count = await pool.query(
      `SELECT count(*)::bigint AS n FROM public.${name}`,
    );
    counts.push({ name, count: count.rows[0].n });
  }
} catch (error) {
  // Print the message only. A pg error can carry the connection string in
  // fields such as `where`, so nothing but the message is shown.
  console.error(`Check failed: ${error.message}`);
  process.exitCode = 2;
} finally {
  await pool.end().catch(() => undefined);
}

const database = (() => {
  try {
    const url = new URL(connectionString);
    return decodeURIComponent(url.pathname.replace(/^\//, "")) || "unknown";
  } catch {
    return "unknown";
  }
})();

const passed = results.every((result) => result.ok);
console.log(`### Rehearsal ${new Date().toISOString().slice(0, 10)}`);
console.log("");
console.log(`Database checked: \`${database}\``);
console.log("");
console.log("| Check | Result | Detail |");
console.log("|---|---|---|");
for (const result of results)
  console.log(
    `| ${result.name} | ${result.ok ? "pass" : "FAIL"} | ${result.detail} |`,
  );
console.log("");
console.log("| Table | Rows |");
console.log("|---|---|");
for (const row of counts) console.log(`| \`${row.name}\` | ${row.count} |`);
console.log("");
for (const note of notes) console.log(`Note: ${note}`);
if (notes.length) console.log("");
console.log(
  passed && process.exitCode !== 2
    ? "All checks passed."
    : "One or more checks failed. Do not sign the rehearsal off.",
);

if (!passed) process.exitCode = 1;
