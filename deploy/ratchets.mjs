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
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'deploy', 'ratchets.json');

const UPDATE = process.argv.includes('--update');

/**
 * `--list` prints what the i18n ratchets actually found, on stderr.
 *
 * A ceiling that says "21" and nothing else is a number you cannot act on: the
 * first thing anyone does is re-implement the measurement in a throwaway
 * script to see the twenty-one. This is that script, kept beside the rule it
 * reports on so the two cannot disagree.
 */
const LIST = process.argv.includes('--list');
function note(kind, file, text) {
  if (LIST) process.stderr.write(`  ${kind}  ${file}  ${String(text).replace(/\s+/g, ' ')}\n`);
}

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
 * Matches `t('…')` / `t("…")` in non-test components, and both arms of
 * `plural(n, '…', '…')` — a counted sentence carries two whole keys and
 * neither of them passes through `t()` at the call site, so a check that only
 * knew about `t()` reported a complete catalogue while every plural was
 * English. Template literals and computed keys are still not counted: they
 * cannot be resolved statically, and a ratchet that guesses is worse than one
 * with a stated blind spot.
 */
function countUntranslatedStrings() {
  const CALL = /\bt\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g;
  const PLURAL = /\bplural\(\s*[^,]+?,\s*'((?:[^'\\]|\\.)*)',\s*'((?:[^'\\]|\\.)*)'/gs;
  const catalogue = read('apps/web/src/locales/fr.ts');
  const keys = new Set();
  for (const file of tracked('apps/web/src/*')) {
    if (!file.endsWith('.tsx') || file.includes('.test.')) continue;
    // The translator's own doc comments show `t('The last update')` as an
    // illustration; counting the example as a missing key is the check
    // reporting on its own documentation. The other two measures already skip
    // this file, for the same reason.
    if (file.endsWith('lib/i18n.tsx')) continue;
    const body = read(file);
    for (const match of body.matchAll(CALL)) {
      const key = match[1] ?? match[2];
      if (key) keys.add(key);
    }
    for (const match of body.matchAll(PLURAL)) {
      keys.add(match[1]);
      keys.add(match[2]);
    }
  }
  let missing = 0;
  for (const key of keys) {
    if (translated(key)) continue;
    missing += 1;
    note('key ', 'apps/web', key);
  }
  return missing;
}

/**
 * User-visible English left hard-coded, anywhere in the web app.
 *
 * The third and last way a string escapes the catalogue, and the only one the
 * other two cannot see: the literal never reaches `t()` at all, so the
 * missing-key check has nothing to look for. `UserMenu` shipped six of these
 * — `Light`, `Transcript`, `Sign out` — with their French already sitting in
 * `fr.ts`, unreachable.
 *
 * It measured far less than it appeared to. All three i18n checks filtered on
 * `body.includes('useT')`, which is exactly right for the two that ask "does
 * this component translate correctly?" and exactly wrong for this one, which
 * asks "is anything left in English?". A component that never adopted i18n at
 * all was invisible to all three at once — and 28 of the 52 text-bearing ones
 * had not: about 270 strings nobody was counting, while the ceiling stood at
 * 31 and read like a rounding error. `MemoryPage` rendered entirely in English
 * next to a French dashboard, and every measurement agreed that i18n was
 * essentially finished.
 *
 * Attributes are counted for the same reason. `title`, `aria-label`,
 * `placeholder` and `alt` are read by somebody — the last two by everybody,
 * the middle one by exactly the users with the least recourse — and a JSX text
 * scan cannot see them. `AppShell` had its whole navigation labelled in
 * English behind `aria-label`, silently.
 *
 * Two exclusions, both narrow. `lib/i18n.tsx` is the translator itself, where
 * the pattern matches type annotations rather than prose. Product names are
 * not translatable strings, so counting them would put a floor under the
 * ceiling that no amount of work could reach.
 *
 * The lookbehind is load-bearing: `() => Promise<Record<K, C>>` in a `.tsx`
 * file offers a `>`, a capitalised word and a `<` in that order, and reads as
 * prose to a regex. A ratchet that cries wolf gets disabled.
 */
const PRODUCT_NAMES = new Set(['Metaclaude', 'Claude', 'Anthropic']);

/**
 * Terms rendered verbatim in every language: commands, paths, env vars, token
 * prefixes, the name of a feature. Named one by one, because "looks like an
 * identifier" is the rule that hid `failed`, `paused` and `staged` — every
 * badge label in the app — behind a pattern written for `sk-ant-oat`.
 */
const VERBATIM = new Set([
  'sk-ant-oat',
  'sk-ant-api',
  'claude setup-token',
  'deploy/install-app.sh',
  'METACLAUDE_BOOTSTRAP_USER',
  'METACLAUDE_BOOTSTRAP_PASSWORD',
  '.env',
  'plugin@',
  'claude.ai',
  'ultracode',
  'Bearer …',
]);

/**
 * The TypeScript compiler, or null where it is not installed.
 *
 * `deploy/check.sh` runs this file off-box, where there may be no
 * `node_modules`; the metrics that need a parser then report as skipped, the
 * same contract the bundle measurement already has. CI installs before running
 * it, so nothing is skipped where it counts.
 */
let cachedTs;
function typescript() {
  if (cachedTs === undefined) {
    try {
      cachedTs = createRequire(join(ROOT, 'package.json'))('typescript');
    } catch {
      cachedTs = null;
    }
  }
  return cachedTs;
}

/** Every non-test component, parsed. */
function* webComponents(ts) {
  for (const file of tracked('apps/web/src/*')) {
    if (!file.endsWith('.tsx') || file.includes('.test.')) continue;
    if (file.endsWith('lib/i18n.tsx')) continue;
    // The error boundary is a class, and deliberately carries its own copy in
    // both languages: it may be catching the very provider `t` comes from, so
    // it must not depend on it. See the comment on `boundaryCopy`.
    if (file.endsWith('components/RootBoundary.tsx')) continue;
    const body = read(file);
    yield {
      file,
      body,
      sf: ts.createSourceFile(file, body, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX),
    };
  }
}

/** A path, a package name, a URL, a slug: the same in every language. */
const CODEISH = /^[a-z0-9_.:/@#-]+$/i;

/**
 * The French catalogue's keys, as a set.
 *
 * Every i18n measure here used to ask `catalogue.includes(key)` — a substring
 * test over the whole file. For a sentence that is accurate enough by
 * accident; for a short label it asks the wrong question entirely. `'Ask'` is
 * a substring of `'Ask the advisor'`, so the six words on the permission
 * control — `Ask`, `Plan`, `Auto`, `Bypass`, `Accept edits` — all read as
 * translated while not one of them was a key. Three measures reported zero,
 * and the control they were meant to cover was in English.
 *
 * Parsed once: the file is a single object literal, so its keys are exactly
 * its entries, and escapes are undone on both sides so `\'` and `'` compare
 * equal.
 */
let cachedCatalogueKeys;
function catalogueKeys() {
  if (cachedCatalogueKeys) return cachedCatalogueKeys;
  const KEY = /^\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|([A-Za-z_$][\w$]*))\s*:/gm;
  cachedCatalogueKeys = new Set();
  for (const match of read('apps/web/src/locales/fr.ts').matchAll(KEY)) {
    cachedCatalogueKeys.add(unescapeKey(match[1] ?? match[2] ?? match[3]));
  }
  return cachedCatalogueKeys;
}

function unescapeKey(text) {
  return text.replace(/\\(['"\\])/g, '$1');
}

/** True when the catalogue carries this exact key. */
function translated(text) {
  return catalogueKeys().has(unescapeKey(text));
}

/**
 * Diagnostics are not copy: `console.error(…)` and `throw new Error(…)` are
 * read in a devtools console, by a developer, in English.
 */
function isDiagnostic(ts, sf, node) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isNewExpression(p) || ts.isThrowStatement(p)) return true;
    if (ts.isCallExpression(p) && /^console\./.test(p.expression.getText(sf))) return true;
  }
  return false;
}

/**
 * A literal outside every function is a module constant, which is the
 * *documented* way to hold copy that must not bake a language in at import time
 * — `t(entry.label)` translates it at render. `hardcodedUiText` therefore skips
 * those (counting them would penalise the correct pattern) and
 * `untranslatedConstants` takes them, by asking the catalogue rather than the
 * syntax.
 */
function insideFunction(ts, node) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isArrowFunction(p)) {
      return true;
    }
  }
  return false;
}

/** Attributes read by somebody, as opposed to the ones that carry machinery. */
const TEXT_ATTRS = new Set([
  'title', 'aria-label', 'placeholder', 'alt', 'description', 'label', 'subtitle',
  'hint', 'tooltip', 'confirmLabel', 'summary', 'content', 'valuePlaceholder',
]);

function countHardcodedUiText() {
  const ts = typescript();
  if (!ts) return null;

  let n = 0;
  for (const { file, sf } of webComponents(ts)) {
    const inTranslator = (node) => {
      for (let p = node.parent; p; p = p.parent) {
        if (
          ts.isCallExpression(p) &&
          ts.isIdentifier(p.expression) &&
          (p.expression.text === 't' || p.expression.text === 'plural')
        ) {
          return true;
        }
      }
      return false;
    };

    const walk = (node) => {
      // JSX text. Lowercase included: a `<Badge>` says `paused`, and the
      // previous pattern required a capital, so every status label in the app
      // was invisible to it.
      if (ts.isJsxText(node)) {
        const text = node.text.replace(/\s+/g, ' ').trim();
        if (/[A-Za-z]{2,}/.test(text) && !PRODUCT_NAMES.has(text) && !VERBATIM.has(text)) {
          n += 1;
          note('jsx ', file, text);
        }
      }
      // A text-bearing attribute given a bare literal. Here — unlike in JSX
      // text, where the same rule hid every lowercase badge — a code-shaped
      // value really is code: these attributes carry the *example* a
      // placeholder shows, and `https://github.com/owner/repo.git` and
      // `release-notes` are the same string in every language.
      if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)) {
        const value = node.initializer.text;
        if (
          TEXT_ATTRS.has(node.name.getText(sf)) &&
          /[A-Za-z]{2,}/.test(value) &&
          !CODEISH.test(value) &&
          !PRODUCT_NAMES.has(value) &&
          !VERBATIM.has(value)
        ) {
          n += 1;
          note('attr', file, value);
        }
      }
      // A sentence in a string literal that never reaches the translator —
      // every toast, every `cond ? 'Archive' : 'Restore'`, every
      // `aria-label={`Actions for ${name}`}`. None of those are JSX text, so
      // no scan of JSX could see them, and they were the larger half.
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        const text = node.text.trim();
        if (
          SENTENCE.test(text) &&
          !VERBATIM.has(text) &&
          insideFunction(ts, node) &&
          !isDiagnostic(ts, sf, node) &&
          !inTranslator(node)
        ) {
          n += 1;
          note('lit ', file, text);
        }
      }
      if (ts.isTemplateExpression(node)) {
        const text = (node.head.text + node.templateSpans.map((s) => s.literal.text).join(' ')).trim();
        if (
          SENTENCE.test(text) &&
          insideFunction(ts, node) &&
          !isDiagnostic(ts, sf, node) &&
          !inTranslator(node)
        ) {
          n += 1;
          note('tpl ', file, text);
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(sf);
  }
  return n;
}

/** Two words or more, opening on a capital: the shape of a sentence, not a key. */
const SENTENCE = /^[A-Z][a-z’'-]+(?:[ ,:’'-][A-Za-z0-9“”’'(){}.…-]+){1,}/;

/**
 * Copy that lives in `packages/shared` and is rendered by the web app.
 *
 * The three i18n measures above scan `apps/web/src`, which is where the copy
 * is — except when it is not. `PERMISSION_MODE_INFO` declares the six
 * permission modes with a label and a description each, in the *contracts*
 * package, and the composer renders them straight into the control an operator
 * touches on every single run. Twelve strings, on the most-used screen in the
 * product, that no i18n check has ever looked at: the ratchets said zero while
 * the permission picker was entirely in English.
 *
 * It cannot be fixed by translating in `packages/shared` — that package must
 * not depend on the web app's catalogue, and it is imported by the API too. So
 * the English stays there as data, the render site calls `t(…)` on it, and
 * this asks the only question left: does the catalogue carry it?
 *
 * Two signals, because one of them is not enough. Prose is caught by its shape,
 * the way it is everywhere else. But a *label* is often a single word — `Ask`,
 * `Auto`, `Bypass` — which no shape test can tell from an enum value, and
 * those are precisely the six words on the permission control. So the value of
 * a `label`/`description`/`hint`/`summary` property is taken whatever it looks
 * like: the property name is the evidence that a person reads it.
 *
 * Comments are stripped first — this package is more comment than code by
 * design, and its prose would otherwise dwarf its copy.
 */
const COPY_PROPERTY = /\b(?:label|description|hint|summary|title)\s*:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g;

function countUntranslatedSharedCopy() {
  const catalogue = read('apps/web/src/locales/fr.ts');
  const missing = new Set();

  const consider = (text) => {
    if (!text || PRODUCT_NAMES.has(text) || VERBATIM.has(text)) return;
    if (!/[A-Za-z]{2}/.test(text)) return;
    if (!translated(text)) missing.add(text);
  };

  for (const file of tracked('packages/shared/src/*')) {
    if (!file.endsWith('.ts') || file.includes('.test.')) continue;
    const code = read(file)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    for (const match of code.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)) {
      const text = match[1] ?? match[2];
      if (text && SENTENCE.test(text)) consider(text);
    }
    for (const match of code.matchAll(COPY_PROPERTY)) {
      consider(match[1] ?? match[2]);
    }
  }

  for (const text of missing) note('shr ', 'packages/shared', text);
  return missing.size;
}

/**
 * Copy held as a module constant that the catalogue does not carry.
 *
 * `i18n.tsx` documents the pattern: a nav entry, a preset list, a risk table
 * keeps its English as *data* and is translated at render with `t(entry.label)`
 * — a constant evaluated at import time must never bake a language in. That is
 * correct, and it is also invisible to both other i18n checks: no `t('…')`
 * call names the string, and it is not JSX text. `DoctorReportView`'s three
 * verdicts and `SessionPage`'s three starter prompts sat in English that way
 * while every measurement said the catalogue was complete.
 *
 * Asking the catalogue rather than the syntax is what makes this safe: a
 * constant whose French exists is right whether or not the render site could
 * be proved to call `t`.
 */
/**
 * Copy tables that are half translated.
 *
 * The three measures above all rest on `SENTENCE`, which requires a capital
 * first letter. That is not fussiness: relaxing it surfaces 76 candidates in
 * this repository and roughly seventy of them are Tailwind class strings —
 * `flex items-start gap-2` is indistinguishable from prose by any cheap rule.
 * So lowercase copy escapes, and it is real copy: `QUESTION_NAMES` interpolated
 * "models, slash commands" into a French sentence for releases, and
 * `TRIGGER_PHRASE` shipped five untranslated segments through a review.
 *
 * This closes the case that actually regresses, with no false positives at
 * all: a module-level object whose string values are *already* in the
 * catalogue is a copy table by demonstration, and every one of its values must
 * be. Adding a sixth entry to a translated table of five is the mistake; a
 * brand-new table is caught the moment its first value is translated.
 */
function countHalfTranslatedTables() {
  const ts = typescript();
  if (!ts) return null;

  let missing = 0;
  for (const { file, sf } of webComponents(ts)) {
    for (const statement of sf.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const decl of statement.declarationList.declarations) {
        if (!decl.initializer || !ts.isObjectLiteralExpression(decl.initializer)) continue;

        const values = [];
        for (const property of decl.initializer.properties) {
          if (!ts.isPropertyAssignment(property)) continue;
          const value = property.initializer;
          if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
            // An empty string is never copy. `EMPTY_DRAFT` in MemoryPage is a
            // form's initial state whose `kind: 'semantic'` happens to be a
            // catalogue key, which would otherwise indict three blank fields.
            if (value.text.trim()) values.push(value.text.trim());
          }
        }
        if (values.length < 2) continue;

        const known = values.filter((text) => translated(text));
        // Demonstrated to be copy, and only then held to the whole set.
        if (known.length === 0) continue;

        for (const text of values) {
          if (translated(text)) continue;
          missing += 1;
          note('half', file, text);
        }
      }
    }
  }
  return missing;
}

function countUntranslatedConstants() {
  const ts = typescript();
  if (!ts) return null;

  const catalogue = read('apps/web/src/locales/fr.ts');
  const missing = new Set();
  for (const { file, sf } of webComponents(ts)) {
    const walk = (node) => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        const text = node.text.trim();
        if (
          SENTENCE.test(text) &&
          !VERBATIM.has(text) &&
          !PRODUCT_NAMES.has(text) &&
          !insideFunction(ts, node) &&
          !isDiagnostic(ts, sf, node) &&
          !translated(text)
        ) {
          missing.add(text);
          note('cst ', file, text);
        }
        return;
      }
      ts.forEachChild(node, walk);
    };
    walk(sf);
  }
  return missing.size;
}

/**
 * Hooks called somewhere React will not run them.
 *
 * The i18n codemods put `const t = useT()` in the *innermost* enclosing
 * function, which for a toast inside `onSuccess: () => {…}` or a row inside
 * `rows.map(row => …)` is a plain callback. React throws on the first call —
 * outside render — and nothing here could see it: TypeScript is happy, the
 * component renders in every test that does not reach that branch, and there
 * is no ESLint in this repo to carry `react-hooks/rules-of-hooks`. Forty-five
 * of them shipped into one working tree before anything noticed.
 *
 * "Where React will run them" is: directly in the body of a function named in
 * PascalCase (a component) or `useSomething` (a hook). Anything else counts.
 */
function countMisplacedHooks() {
  const ts = typescript();
  if (!ts) return null;

  let n = 0;
  for (const { sf } of webComponents(ts)) {
    const nameOf = (fn) => {
      if (ts.isFunctionDeclaration(fn) && fn.name) return fn.name.getText(sf);
      let node = fn.parent;
      while (node && (ts.isCallExpression(node) || ts.isParenthesizedExpression(node))) {
        node = node.parent;
      }
      if (node && ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        return node.name.getText(sf);
      }
      return fn.name ? fn.name.getText(sf) : null;
    };

    const walk = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        /^use[A-Z]/.test(node.expression.text)
      ) {
        let owner = null;
        for (let cur = node.parent; cur && !owner; cur = cur.parent) {
          if (
            ts.isFunctionDeclaration(cur) ||
            ts.isFunctionExpression(cur) ||
            ts.isArrowFunction(cur)
          ) {
            owner = cur;
          }
        }
        const name = owner ? nameOf(owner) : null;
        // No enclosing function at all is a module-level `useSomething()`,
        // which is equally wrong; an unnamed one cannot be a component.
        if (!name || !(/^[A-Z]/.test(name) || /^use[A-Z]/.test(name))) n += 1;
      }
      ts.forEachChild(node, walk);
    };
    walk(sf);
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
  // The *import*, not the word. `body.includes('useT')` also matches a comment
  // explaining why a component does not use the hook — which is exactly what
  // `RootBoundary` says, and it tripped this check on prose. Same family as
  // the raw-palette ratchet, and easier to fix here: an import is unambiguous.
  const IMPORTS_HOOK = /import\s*\{[^}]*\buseT\b[^}]*\}\s*from\s*'@\/lib\/i18n'/;
  let n = 0;
  for (const file of tracked('apps/web/src/*')) {
    if (!file.endsWith('.tsx') || file.includes('.test.')) continue;
    const body = read(file);
    if (!IMPORTS_HOOK.test(body)) continue;
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
  // Two files are excluded on purpose rather than given hollow tests:
  //   • `test/render.tsx` is the harness every other test renders through, so
  //     it is exercised by all of them; a test *of* it would assert that the
  //     providers it mounts are mounted, which is what its callers already
  //     prove far better.
  //   • `main.tsx` is the bootstrap — `createRoot` and a service-worker
  //     registration guarded by `import.meta.env.PROD`. There is no behaviour
  //     to hold still that the browser check in `apps/api/scripts` does not
  //     already exercise against a real page.
  const EXCLUDED = ['apps/web/src/test/render.tsx', 'apps/web/src/main.tsx'];
  let n = 0;
  for (const file of tracked('apps/web/src/*')) {
    if (!file.endsWith('.tsx') || file.includes('.test.')) continue;
    if (EXCLUDED.includes(file)) continue;
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
    // Needs a parser; skipped where `node_modules` is absent.
    optional: true,
  },
  {
    key: 'untranslatedSharedCopy',
    direction: 'down',
    label: 'copy in packages/shared the French catalogue does not carry',
    measure: countUntranslatedSharedCopy,
  },
  {
    key: 'untranslatedConstants',
    direction: 'down',
    label: 'module-level copy the French catalogue does not carry',
    measure: countUntranslatedConstants,
    optional: true,
  },
  {
    key: 'halfTranslatedTables',
    direction: 'down',
    label: 'copy tables the French catalogue carries only part of',
    measure: countHalfTranslatedTables,
    optional: true,
  },
  {
    key: 'misplacedHooks',
    direction: 'down',
    label: 'hooks called outside a component or a hook',
    measure: countMisplacedHooks,
    optional: true,
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
