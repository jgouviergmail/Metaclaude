#!/usr/bin/env node
/**
 * Quality ratchets.
 *
 *     node deploy/ratchets.mjs            # verify — fails if anything regressed
 *     node deploy/ratchets.mjs --update   # record improvements, never regressions
 *
 * A ratchet is a number that may only move in the improving direction. Tests
 * prove the code works today; a ratchet is what stops tomorrow quietly costing
 * you what today bought — a suite that shrinks because a file was deleted, a
 * bundle that creeps back up one import at a time, a raw palette class that
 * reappears and breaks the light theme for exactly one component.
 *
 * `--update` is deliberately one-directional. It will raise a floor and lower a
 * ceiling; it will never do the reverse, so running it cannot launder a
 * regression into the baseline. Making a number worse is a deliberate edit to
 * ratchets.json, in a commit, with a reason.
 *
 * Every metric here is computed statically. Nothing in this file runs the test
 * suite or the build: it must stay cheap enough that `deploy/check.sh` can call
 * it on every run, and honest enough that CI cannot pass while it is stale.
 */

import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'deploy', 'ratchets.json');

const UPDATE = process.argv.includes('--update');

/* -------------------------------------------------------------------------- */
/* Measurements                                                               */
/* -------------------------------------------------------------------------- */

/** Every tracked file, so a metric can never be fooled by an untracked scratch copy. */
function tracked(pattern) {
  const out = execFileSync('git', ['ls-files', '-z', pattern], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\0').filter(Boolean);
}

function read(path) {
  return readFileSync(join(ROOT, path), 'utf8');
}

/**
 * Test cases, counted from source rather than from a runner's summary.
 *
 * Counting `it(` and `test(` overstates nothing that matters: a skipped test is
 * `it.skip(` and does not match, and a test that is deleted stops counting. It
 * is a floor on intent, and it costs no seconds.
 */
function countTests() {
  let n = 0;
  for (const file of tracked('*.test.ts').concat(tracked('*.test.tsx'))) {
    const body = read(file);
    n += (body.match(/^\s*(?:it|test)\(/gm) ?? []).length;
  }
  return n;
}

/** Files carrying at least one test — a suite spread thin is a different risk. */
function countTestFiles() {
  return tracked('*.test.ts').concat(tracked('*.test.tsx')).length;
}

/**
 * Raw Tailwind palette classes in the web app.
 *
 * CLAUDE.md forbids them because they are invisible in dark mode review and
 * break the light theme. The floor is zero and the ratchet exists to keep it
 * there — this is the metric most likely to regress by accident, one hurried
 * component at a time.
 */
function countRawPalette() {
  const PALETTE =
    /\b(?:bg|text|border|ring|from|to|via|fill|stroke|decoration|outline|shadow|accent|caret|divide)-(?:gray|slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g;
  let n = 0;
  for (const file of tracked('apps/web/src/*')) {
    if (!/\.(tsx?|css)$/.test(file)) continue;
    n += (read(file).match(PALETTE) ?? []).length;
  }
  return n;
}

/**
 * Bytes of JavaScript a browser must fetch before it can paint the sign-in
 * screen — the entry script plus everything index.html preloads, gzipped.
 *
 * Measured from the built artefact, so it cannot be argued with. Returns null
 * when there is no build, and a null is reported rather than treated as a pass:
 * a ceiling nobody measures is not a ceiling.
 */
async function measureInitialJs() {
  const dist = join(ROOT, 'apps/web/dist');
  if (!existsSync(join(dist, 'index.html'))) return null;
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  const names = new Set([...html.matchAll(/assets\/([^"']+\.js)/g)].map((m) => m[1]));
  if (names.size === 0) return null;

  let total = 0;
  for (const name of names) {
    const path = join(dist, 'assets', name);
    if (!existsSync(path)) continue;
    total += gzipSync(readFileSync(path), { level: 9 }).length;
  }
  return Math.round(total / 1024);
}

/** Source files with no test file beside them, in the subsystems that matter most. */
function countUntestedCriticalModules() {
  const CRITICAL = ['apps/api/src/kernel/', 'apps/api/src/security/', 'apps/api/src/learning/'];
  let n = 0;
  for (const file of tracked('apps/api/src/*')) {
    if (!CRITICAL.some((dir) => file.startsWith(dir))) continue;
    if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
    if (!existsSync(join(ROOT, file.replace(/\.ts$/, '.test.ts')))) n += 1;
  }
  return n;
}

/* -------------------------------------------------------------------------- */
/* The ratchet                                                                */
/* -------------------------------------------------------------------------- */

/** direction: 'up' means higher is better (a floor); 'down' means lower is better (a ceiling). */
const METRICS = [
  { key: 'tests', direction: 'up', label: 'test cases', measure: countTests },
  { key: 'testFiles', direction: 'up', label: 'files carrying tests', measure: countTestFiles },
  { key: 'rawPaletteClasses', direction: 'down', label: 'raw Tailwind palette classes', measure: countRawPalette },
  {
    key: 'untestedCriticalModules',
    direction: 'down',
    label: 'kernel/security/learning modules with no test file',
    measure: countUntestedCriticalModules,
  },
  {
    key: 'initialJsGzipKb',
    direction: 'down',
    label: 'initial JS, gzipped (kB)',
    measure: measureInitialJs,
    // Requires a build. Absent, it is reported and skipped rather than passed.
    optional: true,
  },
];

async function main() {
  const baseline = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : { metrics: {} };
  const next = { ...baseline, metrics: { ...baseline.metrics } };

  let failed = 0;
  let improved = 0;
  const lines = [];

  for (const metric of METRICS) {
    const current = await metric.measure();
    if (current === null || current === undefined) {
      lines.push(`  skip ${metric.label} — not measurable here`);
      continue;
    }
    const floor = baseline.metrics[metric.key];

    if (floor === undefined) {
      next.metrics[metric.key] = current;
      improved += 1;
      lines.push(`  new  ${metric.label}: ${current}`);
      continue;
    }

    const better = metric.direction === 'up' ? current > floor : current < floor;
    const worse = metric.direction === 'up' ? current < floor : current > floor;

    if (worse) {
      failed += 1;
      const word = metric.direction === 'up' ? 'fell below' : 'rose above';
      lines.push(`  FAIL ${metric.label}: ${current} ${word} the ratchet of ${floor}`);
    } else if (better) {
      improved += 1;
      lines.push(`  ${UPDATE ? 'up  ' : 'ok  '} ${metric.label}: ${current} (ratchet ${floor})`);
      if (UPDATE) next.metrics[metric.key] = current;
    } else {
      lines.push(`  ok   ${metric.label}: ${current}`);
    }
  }

  process.stdout.write(lines.join('\n') + '\n');

  if (UPDATE) {
    next.updated = new Date().toISOString().slice(0, 10);
    writeFileSync(FILE, JSON.stringify(next, null, 2) + '\n');
    process.stdout.write(`\n  wrote ${FILE.replace(ROOT + '/', '')}${improved ? ` — ${improved} improved` : ''}\n`);
  }

  if (failed > 0) {
    process.stdout.write(
      `\n  ${failed} ratchet(s) regressed. Fix the regression, or edit deploy/ratchets.json\n` +
        '  deliberately and say why in the commit.\n',
    );
    process.exit(1);
  }
}

await main();
