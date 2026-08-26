#!/usr/bin/env node
/**
 * Bump the product version — the one command behind "every push increments".
 *
 *   node deploy/bump.mjs [patch|minor|major]     (default: patch)
 *
 * The version is declared in five places that must agree: APP_VERSION in
 * packages/shared/src/constants.ts (the source the product itself reads) and
 * the four package.json files. This script refuses to run when they already
 * disagree — drift means someone edited by hand, and a tool that silently
 * picks a winner would bury that mistake instead of surfacing it.
 *
 * It also refuses to bump while CHANGELOG.md's [Unreleased] section is empty.
 * The in-app "What's new" renders that file; a version whose entry says
 * nothing is a release lying about itself, and deploy/check.sh would reject
 * the result anyway — refusing here just moves the error to where the fix is.
 *
 * CI enforces the other half of the contract: a push to main whose version
 * did not increase fails the version-guard job (deploy/version-guard.sh).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const CONSTANTS = join(ROOT, 'packages/shared/src/constants.ts');
const PACKAGES = [
  join(ROOT, 'package.json'),
  join(ROOT, 'apps/api/package.json'),
  join(ROOT, 'apps/web/package.json'),
  join(ROOT, 'packages/shared/package.json'),
];
const CHANGELOG = join(ROOT, 'CHANGELOG.md');

function die(message) {
  console.error(`bump: ${message}`);
  process.exit(1);
}

const kind = process.argv[2] ?? 'patch';
if (!['patch', 'minor', 'major'].includes(kind)) {
  die(`unknown bump kind "${kind}" — expected patch, minor or major`);
}

/* ── Read and validate everything before writing anything ────────────────── */

const constantsSource = readFileSync(CONSTANTS, 'utf8');
const versionMatch = constantsSource.match(/APP_VERSION = '(\d+)\.(\d+)\.(\d+)'/);
if (!versionMatch) die(`${CONSTANTS} no longer declares APP_VERSION where this script looks`);
const current = `${versionMatch[1]}.${versionMatch[2]}.${versionMatch[3]}`;

const packageSources = PACKAGES.map((path) => {
  const source = readFileSync(path, 'utf8');
  const match = source.match(/"version":\s*"([^"]+)"/);
  if (!match) die(`${path} has no version field`);
  if (match[1] !== current) {
    die(
      `${path} says ${match[1]} but APP_VERSION says ${current} — ` +
        'the declarations have drifted; fix them by hand before bumping',
    );
  }
  return { path, source };
});

const changelog = readFileSync(CHANGELOG, 'utf8');
const unreleasedAt = changelog.indexOf('## [Unreleased]');
if (unreleasedAt < 0) die('CHANGELOG.md has no [Unreleased] section');
const nextHeadingAt = changelog.indexOf('\n## [', unreleasedAt + 1);
const unreleasedBody = changelog.slice(
  unreleasedAt,
  nextHeadingAt > 0 ? nextHeadingAt : changelog.length,
);
if (!/^- /m.test(unreleasedBody)) {
  die(
    '[Unreleased] in CHANGELOG.md carries no entry — write what this version ' +
      'changes first; a release with nothing to say is a version lying about itself',
  );
}

const [major, minor, patch] = current.split('.').map(Number);
const next =
  kind === 'major' ? `${major + 1}.0.0` : kind === 'minor' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;

const today = new Date().toISOString().slice(0, 10);

/* ── Write all six files ─────────────────────────────────────────────────── */

writeFileSync(CONSTANTS, constantsSource.replace(versionMatch[0], `APP_VERSION = '${next}'`));

for (const { path, source } of packageSources) {
  writeFileSync(path, source.replace(/"version":\s*"[^"]+"/, `"version": "${next}"`));
}

writeFileSync(
  CHANGELOG,
  changelog.replace('## [Unreleased]', `## [Unreleased]\n\n## [${next}] — ${today}`),
);

console.log(`bump: ${current} → ${next} (${kind})`);
console.log('bump: APP_VERSION, four package.json files and CHANGELOG.md updated');
