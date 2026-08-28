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
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'deploy', 'ratchets.json');

const UPDATE = process.argv.includes('--update');

/* -------------------------------------------------------------------------- */
/* Measurements                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Every file git would keep, tracked or not yet added.
 *
 * `--others --exclude-standard` is what makes a brand-new test file count on
 * the run that creates it. Counting only tracked files meant a lot's own tests
 * were invisible until they were staged, so the ratchet reported no
 * improvement at the exact moment there was one — and anything .gitignore
 * covers is still excluded, which is the property that mattered.
 */
function tracked(pattern) {
  const out = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', pattern],
    { cwd: ROOT, encoding: 'utf8' },
  );
  return [...new Set(out.split('\0').filter(Boolean))];
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

/**
 * Assertions in the deployment layer's own check.
 *
 * Counted separately from the unit tests because it protects something the unit
 * tests cannot reach: `deploy/` is the only code here that can lock the owner
 * out of their own machine, and it is exercised by `check.sh` rather than by
 * Vitest. Without a floor of its own, a section could be deleted and the
 * headline test count would not notice.
 *
 * Counts the calls, not the reported passes: this file must stay static, and a
 * number that required running the checks would make `check.sh` recursive.
 */
function countDeployChecks() {
  const body = read('deploy/check.sh');
  // Definitions of ok()/bad()/skip() themselves are not assertions.
  return (body.match(/^\s+(?:ok|bad|skip)\s+"/gm) ?? []).length;
}

/**
 * UI strings the French catalogue does not carry.
 *
 * The app ships in two languages and `t()` falls back to its English key when
 * a translation is missing, so an untranslated string is invisible in every
 * test, every typecheck and every English-language review — it shows up only
 * as one English button in the middle of a French screen, to the person using
 * it. Measured once by hand at 411 keys and one gap; a ratchet is what keeps
 * that from drifting back, since each new feature adds keys.
 *
 * Matches `t('…')` / `t("…")` in non-test components. Template literals and
 * computed keys are not counted: they cannot be resolved statically, and a
 * ratchet that guesses is worse than one with a stated blind spot.
 */
function countUntranslatedStrings() {
  const CALL = /\bt\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g;
  const catalogue = read('apps/web/src/locales/fr.ts');
  const keys = new Set();
  for (const file of tracked('apps/web/src/*')) {
    if (!file.endsWith('.tsx') || file.includes('.test.')) continue;
    for (const match of read(file).matchAll(CALL)) {
      const key = match[1] ?? match[2];
      if (key) keys.add(key);
    }
  }
  let missing = 0;
  for (const key of keys) {
    if (!catalogue.includes(key) && !catalogue.includes(key.replace(/\\'/g, "'"))) missing += 1;
  }
  return missing;
}

/**
 * User-visible English left hard-coded in a component that already translates.
 *
 * The third and last way a string escapes the catalogue, and the only one the
 * other two cannot see: the component calls `t()` elsewhere, so the hook
 * check passes, and the literal never reaches `t()` at all, so the
 * missing-key check has nothing to look for. `UserMenu` shipped six of these
 * — `Light`, `Transcript`, `Sign out` — with their French already sitting in
 * `fr.ts`, unreachable.
 *
 * A ceiling rather than a floor of zero: `AgentsPage` carries most of what is
 * left, and lowering it is ordinary follow-up work. `lib/i18n.tsx` is skipped
 * because it is the translator itself, where the pattern matches type
 * annotations rather than prose.
 */
function countHardcodedUiText() {
  const TEXT = />\s*([A-Z][a-z]+(?: [A-Za-z’']+){0,5})\s*</g;
  let n = 0;
  for (const file of tracked('apps/web/src/*')) {
    if (!file.endsWith('.tsx') || file.includes('.test.')) continue;
    if (file.endsWith('lib/i18n.tsx')) continue;
    const body = read(file);
    if (!body.includes('useT')) continue;
    n += (body.match(TEXT) ?? []).length;
  }
  return n;
}

/**
 * Components that pull in `useT` and never call it.
 *
 * `t()` falls back to its English key, so a *missing* translation is invisible
 * — the previous ratchet covers that direction. This is the other one: a
 * component that imports the hook, renders raw English, and leaves the
 * catalogue carrying translations nothing reaches. `ConnectionBadge` did
 * exactly that for all four of its states, with the French strings sitting in
 * `fr.ts` unused.
 *
 * The reverse check — catalogue entries no `t()` call references — was tried
 * and rejected: `t(column.label)` and `t(action.group)` pass variables, so 89
 * of 488 entries looked orphaned and almost none were. A ratchet that cries
 * wolf gets disabled; this one cannot, because importing a hook and never
 * calling it has no legitimate form.
 */
function countUnusedTranslationHooks() {
  let n = 0;
  for (const file of tracked('apps/web/src/*')) {
    if (!file.endsWith('.tsx') || file.includes('.test.')) continue;
    const body = read(file);
    if (!body.includes('useT')) continue;
    if (!/\bt\(/.test(body)) n += 1;
  }
  return n;
}

/**
 * React components with no sibling test file.
 *
 * The API is tested at 0.86 lines of test per line of source; the web app was
 * at 0.27, and the gap was invisible because both suites are green. Measured
 * once: 25 of 65 components had no test at all, including every major page —
 * `MemoryPage.tsx` among them, a thousand lines of the screen two consecutive
 * lots had just modified.
 *
 * Counted per file rather than per line: a component is either exercised by
 * something or it is not, and a large component with one shallow test is a
 * different problem that a line count would hide.
 */
function countUntestedComponents() {
  let n = 0;
  for (const file of tracked('apps/web/src/*')) {
    if (!file.endsWith('.tsx') || file.includes('.test.')) continue;
    if (!existsSync(join(ROOT, file.replace(/\.tsx$/, '.test.tsx')))) n += 1;
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
  {
    key: 'deployChecks',
    direction: 'up',
    label: 'assertions in deploy/check.sh',
    measure: countDeployChecks,
  },
  { key: 'rawPaletteClasses', direction: 'down', label: 'raw Tailwind palette classes', measure: countRawPalette },
  {
    key: 'untranslatedStrings',
    direction: 'down',
    label: 'UI strings missing from the French catalogue',
    measure: countUntranslatedStrings,
  },
  {
    key: 'hardcodedUiText',
    direction: 'down',
    label: 'user-visible English not routed through t()',
    measure: countHardcodedUiText,
  },
  {
    key: 'unusedTranslationHooks',
    direction: 'down',
    label: 'components importing useT without calling it',
    measure: countUnusedTranslationHooks,
  },
  {
    key: 'untestedComponents',
    direction: 'down',
    label: 'React components with no test file',
    measure: countUntestedComponents,
  },
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
