#!/usr/bin/env node
// Dependency advisory gate for CI and for checklist item 14 in
// docs/auth/RELEASE.md.
//
// Runs `pnpm audit --json`, and fails when any advisory with a blocking
// severity is not covered by an entry in .audit-exceptions.json. An exception
// that has passed its `until` date fails too, so an accepted advisory cannot be
// accepted for ever. Everything it accepts is printed, so a green run still
// says what it let through.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const exceptionsFile = join(repoRoot, '.audit-exceptions.json');

// Severities that stop the build. Lower this only in a local dry run; never
// commit a lowered threshold.
const BLOCKING = new Set(['high', 'critical']);

function runAudit() {
  // pnpm exits non-zero whenever it found anything, so the exit code says
  // nothing useful here. Read stdout either way and let the parse decide.
  const result = spawnSync('pnpm', ['audit', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error) {
    fail(`could not run pnpm audit: ${result.error.message}`);
  }

  const stdout = (result.stdout ?? '').trim();
  if (stdout === '') {
    fail(
      `pnpm audit printed nothing (exit ${result.status}). stderr:\n${result.stderr ?? ''}`,
    );
  }

  try {
    return JSON.parse(stdout);
  } catch {
    fail(`pnpm audit did not print JSON (exit ${result.status}):\n${stdout.slice(0, 2000)}`);
  }
}

function readExceptions() {
  let raw;
  try {
    raw = readFileSync(exceptionsFile, 'utf8');
  } catch {
    // No file means no exceptions, which is the state we want to be in.
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`.audit-exceptions.json is not valid JSON: ${error.message}`);
  }

  const list = parsed?.exceptions;
  if (!Array.isArray(list)) {
    fail('.audit-exceptions.json must be { "exceptions": [ ... ] }');
  }

  return list.map((entry, index) => {
    const where = `.audit-exceptions.json entry ${index + 1}`;
    for (const key of ['id', 'package', 'reason', 'until']) {
      if (typeof entry?.[key] !== 'string' || entry[key].trim() === '') {
        fail(`${where} is missing "${key}"`);
      }
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.until)) {
      fail(`${where} has until "${entry.until}"; write it as YYYY-MM-DD`);
    }
    return entry;
  });
}

// An exception matches on the package plus either the numeric advisory id or
// the GitHub advisory, given as the id (GHSA-...) or as the full advisory URL.
function matches(exception, advisory) {
  if (exception.package !== advisory.module_name) return false;

  const wanted = exception.id.trim().toLowerCase();
  const keys = [
    String(advisory.id ?? ''),
    String(advisory.github_advisory_id ?? ''),
    String(advisory.url ?? ''),
  ]
    .filter((value) => value !== '' && value !== 'null')
    .map((value) => value.toLowerCase());

  return keys.includes(wanted);
}

function fail(message) {
  console.error(`audit-deps: ${message}`);
  process.exit(1);
}

const report = runAudit();
const exceptions = readExceptions();
const advisories = Object.values(report?.advisories ?? {});
const today = new Date().toISOString().slice(0, 10);

const counts = report?.metadata?.vulnerabilities ?? {};
console.log(
  `audit-deps: ${advisories.length} advisory/advisories reported ` +
    `(critical ${counts.critical ?? 0}, high ${counts.high ?? 0}, ` +
    `moderate ${counts.moderate ?? 0}, low ${counts.low ?? 0}, info ${counts.info ?? 0}).`,
);
console.log(`audit-deps: blocking severities are ${[...BLOCKING].join(' and ')}.`);

const blocking = advisories.filter((advisory) => BLOCKING.has(advisory.severity));

const accepted = [];
const unexcused = [];
const expired = [];

for (const advisory of blocking) {
  const exception = exceptions.find((entry) => matches(entry, advisory));
  if (!exception) {
    unexcused.push(advisory);
  } else if (exception.until < today) {
    expired.push({ advisory, exception });
  } else {
    accepted.push({ advisory, exception });
  }
}

for (const { advisory, exception } of accepted) {
  console.log(
    `audit-deps: accepted ${advisory.severity} ${advisory.github_advisory_id ?? advisory.id} ` +
      `in ${advisory.module_name} until ${exception.until}: ${exception.reason}`,
  );
}

for (const { advisory, exception } of expired) {
  console.error(
    `audit-deps: BLOCKING ${advisory.severity} ${advisory.github_advisory_id ?? advisory.id} ` +
      `in ${advisory.module_name}: exception expired on ${exception.until} (today is ${today}). ` +
      `${advisory.url ?? ''}`,
  );
}

for (const advisory of unexcused) {
  const paths = advisory.findings?.flatMap((finding) => finding.paths ?? []) ?? [];
  console.error(
    `audit-deps: BLOCKING ${advisory.severity} ${advisory.github_advisory_id ?? advisory.id} ` +
      `in ${advisory.module_name} ${advisory.vulnerable_versions ?? ''} ` +
      `(fixed in ${advisory.patched_versions ?? 'no published fix'}): ${advisory.title}. ` +
      `${advisory.url ?? ''}${paths.length > 0 ? `\n  path: ${paths[0]}` : ''}`,
  );
}

// An exception for an advisory that is no longer reported is dead weight, but
// it is not a reason to stop a release. Say so and move on.
for (const exception of exceptions) {
  if (!blocking.some((advisory) => matches(exception, advisory))) {
    console.log(
      `audit-deps: exception for ${exception.id} in ${exception.package} matched nothing; remove it.`,
    );
  }
}

const failures = unexcused.length + expired.length;
if (failures > 0) {
  console.error(
    `audit-deps: ${failures} advisory/advisories must be fixed or written into .audit-exceptions.json.`,
  );
  process.exit(1);
}

console.log('audit-deps: no blocking advisories.');
