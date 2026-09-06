/**
 * Responsive check: no interactive control is clipped or unreachable.
 *
 * Why this check exists, and why it looks nothing like the one before it.
 * `browser.mjs` measured `documentElement.scrollWidth - clientWidth` on two
 * pages. Three separate things made that blind:
 *
 *  1. This app's clipper is neither `body` nor `html` but the AppShell's
 *     `overflow-hidden` div, which STOPS the propagation: the document never
 *     overflows, whatever happens inside it.
 *  2. Under `isMobile`, `window.innerWidth` reports the *visual* viewport,
 *     which widens with the overflowing content — measured at 530 for a
 *     `documentElement.clientWidth` of 390. The worse the defect, the better
 *     it hides. Nothing here compares against anything but `clientWidth`.
 *  3. French runs ~40% longer than English, and French is what overflows. The
 *     account menu falling off the workspaces header existed only in French.
 *
 * The invariant: an element outside the frame is a defect if and only if the
 * FIRST ancestor that overflows is not horizontally scrollable. A scrollable
 * ancestor means "reachable by scrolling" — the board's columns and the tab
 * strips, deliberate. An `overflow: visible` ancestor means "clipped by
 * something above", which is the defect this file exists to catch.
 *
 * Every route gets a positive control injected. Without it, "zero defects" is
 * indistinguishable from a broken probe — and this probe has been broken three
 * times while reporting zero.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { Client, PASSWORD, REPO_ROOT, Results, startServer, USERNAME } from './harness.mjs';

const WEB_DIST = join(REPO_ROOT, 'apps', 'web', 'dist');
if (!existsSync(join(WEB_DIST, 'index.html'))) {
  console.error(`No built web app at ${WEB_DIST}. Run \`pnpm build\` first.`);
  process.exit(1);
}

/**
 * The French catalogue, read by the AST rather than guessed by a regex.
 *
 * A regex over `key: 'value',` lines misses every entry whose value sits on the
 * next line — and a missed key is a *false negative* here: the English would
 * show on a French screen and this check would say nothing. Measured: the
 * regex and the AST both reported 1626, two cancelling errors, and only the
 * AST actually held the multi-line entries.
 *
 * Entries whose French equals the English are excluded by construction: 57 of
 * them are a deliberate choice (`workspace` stays `workspace`), and they can
 * never be evidence of anything.
 */
function frenchCatalogue() {
  const require = createRequire(join(REPO_ROOT, 'apps/web/package.json'));
  const ts = require('typescript');
  const path = join(REPO_ROOT, 'apps/web/src/locales/fr.ts');
  const sf = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  const translated = [];
  const walk = (node) => {
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
          ? property.name.text
          : null;
        const init = property.initializer;
        const value =
          ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init) ? init.text : null;
        if (key !== null && value !== null && key !== value) translated.push(key);
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);
  return translated;
}

const FRENCH_KEYS = frenchCatalogue();

const results = new Results();
const server = await startServer({ webDir: WEB_DIST, env: { NODE_ENV: 'production' } });
const { context } = server;
const now = Date.now();

/* ------------------------------ Adversarial seed -------------------------- */
/*
 * An empty deployment cannot overflow: a board with no cards, a memory with no
 * long title, and the check passes on an app it never exercised. So the seed is
 * what actually overflows — long French, unbreakable tokens, a URL, an
 * all-caps identifier.
 */
const ws = context.workspaceRepo.update((await context.systemWorkspace.ensure()).id, {
  description:
    "L'espace de travail système de Metaclaude, celui depuis lequel l'agent intervient sur son propre déploiement",
});

const MEMORIES = [
  [
    'semantic',
    "La chaîne d'audit est ordonnée par rowid et non par horodatage, parce que les identifiants portent un suffixe aléatoire",
  ],
  ['semantic', 'METACLAUDE_WORKSPACES_DIR_MUST_NOT_BE_NESTED_INSIDE_METACLAUDE_DATA_DIR'],
  ['episodic', 'https://myclaude.jeyswork.com/api/system/update-apply?version=v0.56.5&requestedBy=jgouvier'],
];
for (const [kind, title] of MEMORIES) {
  context.memory.remember({
    workspaceId: ws.id,
    kind,
    title,
    content: `${title}. ${'Le détail complet de cette mémoire tient en plusieurs phrases. '.repeat(5)}`,
    tags: ['configuration', 'piège-connu', 'production'],
    confidence: 0.8,
    shelf: 'durable',
  });
}

const { BoardService } = await import(
  pathToFileURL(join(REPO_ROOT, 'apps/api/dist/services/board.js')).href
);
const board = new BoardService(context.db);
const CARDS = [
  ['backlog', "Dessiner la légende de la constellation sur l'affichage mobile sans casser le thème clair", 'improvement'],
  ['backlog', 'ReconnexionSocketIntermittenteApresVeilleProlongeeDuTelephone', 'bug'],
  ['todo', "Reprendre entièrement la mise en page de l'écran des réglages, section par section", 'task'],
  ['in_progress', 'Corriger le rognage de la carte des espaces sur le tableau de bord en 390 pixels', 'bug'],
  ['review', "Courbes bêta dans l'analytique, avec les intervalles de crédibilité", 'improvement'],
  ['done', "Corriger la barre d'onglets iOS et la zone de l'indicateur d'accueil", 'bug'],
];
for (const [status, title, kind] of CARDS) {
  board.create({ workspaceId: ws.id, title, createdBy: 'user:jules', status, kind }, 'user:jules');
}

const session = context.sessionRepo.create({
  workspaceId: ws.id,
  title: "Reprise de la mise en page des réglages et de l'écran des automatisations",
  model: 'sonnet',
  effort: 'high',
  permissionMode: 'default',
});
const run = context.runRepo.create({
  sessionId: session.id,
  workspaceId: ws.id,
  prompt: "Reprends la mise en page de l'écran des réglages",
  policy: {
    model: 'sonnet',
    effort: 'high',
    permissionMode: 'default',
    thinking: 'adaptive',
    thinkingBudgetTokens: null,
    agentName: null,
    ultracode: false,
    source: 'workspace',
  },
  triggeredBy: 'user',
  category: 'engineering',
});
context.db
  .prepare('UPDATE runs SET status = ?, started_at = ?, finished_at = ? WHERE id = ?')
  .run('succeeded', now - 600_000, now - 60_000, run.id);

const EVENTS = [
  {
    kind: 'user_message',
    attachments: [],
    text: 'Reprends la mise en page, en commençant par https://myclaude.jeyswork.com/settings?tab=configuration&density=comfortable',
  },
  {
    kind: 'assistant_text',
    streaming: false,
    text:
      'Voici le plan. ' +
      "Chaque section devient un bloc séparé par un filet plutôt qu'une carte encadrée. ".repeat(3) +
      '\n\n```ts\nconst UnIdentifiantVolontairementTresLongPourTesterLeDebordement = 1;\n```\n',
  },
];
EVENTS.forEach((event, seq) => {
  context.transcriptRepo.append(session.id, {
    ...event,
    id: `evt_resp${seq}`,
    runId: run.id,
    seq,
    at: now - 300_000 + seq * 1000,
  });
});

const client = new Client(server.baseUrl);
await client.login();
await client.call('/api/automations', {
  method: 'POST',
  body: {
    workspaceId: ws.id,
    name: 'Revue matinale du déploiement et des incidents de la nuit précédente',
    description: "Passe en revue les runs échoués, les cartes en attente et l'état du docteur",
    trigger: { type: 'schedule', cron: '0 9 * * *' },
    prompt: 'Fais la revue',
  },
});

/* --------------------------------- Invariants ----------------------------- */

const AUDIT = `
  (async () => {
    const settle = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const SEL = 'button, a[href], [role="button"], input, select, textarea, [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="switch"], [role="checkbox"]';
    // Never window.innerWidth: under isMobile it widens with the overflow.
    const VW = document.documentElement.clientWidth;
    const VH = document.documentElement.clientHeight;
    const nameOf = (el) =>
      (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent.trim() ||
       (el.labels && el.labels[0] ? el.labels[0].textContent : '') || '').replace(/\\s+/g, ' ').trim();
    const short = (el) => (nameOf(el) || '<' + el.tagName.toLowerCase() + '>').slice(0, 40);
    // Behind an open modal Radix marks the rest aria-hidden. Not a defect.
    const inert = (el) => el.closest('[aria-hidden="true"], [inert]') !== null;
    const verdict = (el) => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        if (p.scrollWidth > p.clientWidth + 1) {
          const ox = getComputedStyle(p).overflowX;
          return {
            scrollable: ox === 'auto' || ox === 'scroll',
            who: p.tagName + '.' + String(p.className).slice(0, 44),
          };
        }
      }
      return { scrollable: false, who: '(html)' };
    };

    const out = { counted: 0, clipped: [], excused: 0, unnamed: [], covered: [], headings: [] };
    const candidates = [];

    for (const el of document.querySelectorAll(SEL)) {
      if (inert(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const s = getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none' || s.opacity === '0') continue;
      out.counted += 1;
      if (!nameOf(el)) out.unnamed.push('<' + el.tagName.toLowerCase() + '> .' + String(el.className).slice(0, 44));
      if (rect.right > VW + 1 || rect.left < -1) {
        const v = verdict(el);
        if (v.scrollable) out.excused += 1;
        else out.clipped.push(short(el) + ' [' + Math.round(rect.left) + '..' + Math.round(rect.right) + ']/' + VW + '  <- ' + v.who);
        continue;
      }
      if (rect.top < 0 || rect.bottom > VH) continue;
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      if (!(hit && (hit === el || el.contains(hit) || hit.contains(el)))) {
        // Not a defect yet: a control passing under a dialog's sticky footer or
        // under the phone tab bar is covered AT THIS SCROLL POSITION, and a
        // scroll clears it. Same reasoning as the horizontal excuse, on the
        // other axis — and the same technique browser.mjs already uses for tap
        // targets, for exactly this reason. Only what stays covered after being
        // scrolled into view is unreachable.
        candidates.push(el);
      }
    }

    // Second pass: scroll each candidate into view and ask again.
    for (const el of candidates) {
      el.scrollIntoView({ block: 'center', inline: 'center' });
      await settle();
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      if (hit && (hit === el || el.contains(hit) || hit.contains(el))) continue;
      // Two nodes of one data visualisation overlapping is a property of the
      // visualisation, not of the page layout: the memory constellation places
      // its stars by recency and similarity, so close neighbours touch. This
      // invariant is about a control clipped or buried by the CHROME around it.
      // What it therefore does NOT cover: a star you cannot click because
      // another sits on it. Those memories stay reachable from the list below,
      // and the constellation's own crowding is a lot 6 question.
      const sameSvg = hit && el.closest('svg') && hit.closest('svg') === el.closest('svg');
      if (sameSvg) continue;
      out.covered.push(
        short(el) + ' <- ' +
        (hit ? hit.tagName + '.' + String(hit.className.baseVal ?? hit.className).slice(0, 30) : 'null') +
        (hit && hit.closest('svg') ? ' (in svg)' : ''),
      );
    }
    // Scrolling moved the page; put it back before reading the outline.
    window.scrollTo(0, 0);

    // A skipped heading level (h1 -> h3) announces a subsection that has no
    // section: a screen reader's outline of the page is simply wrong.
    let previous = 0;
    for (const h of document.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
      const level = Number(h.tagName[1]);
      if (previous && level > previous + 1) {
        out.headings.push('h' + previous + ' -> h' + level + ' : ' + h.textContent.trim().slice(0, 30));
      }
      previous = level;
    }
    return out;
  })()
`;

/**
 * Copy that stayed English on a French screen.
 *
 * The rule admits no false positive by construction: a run of text is a defect
 * only when it is *exactly* a catalogue key whose French value differs. It
 * cannot indict a proper noun, a workspace name, a number, or a sentence
 * assembled from several translated fragments — none of those equal a key.
 *
 * Accessible names count too, and for a reason this very lot demonstrated: the
 * System strip shipped with an untranslated `aria-label` and the check said
 * nothing, because it only walked text nodes. A name nobody sees is still copy
 * — it is what a screen-reader user hears and what voice control listens for.
 *
 * Three exclusions, each for a stated reason rather than to make the number
 * look better:
 *  - `.prose-mc` is rendered markdown: the agent's own words and the user's,
 *    plus the guide and the changelog, which stay English by design.
 *  - `<code>` and `<pre>` are identifiers and commands, never copy.
 *  - `/help` renders that corpus wholesale.
 *
 * What this catches that no static measure could: copy that reaches the screen
 * through a path the ratchets cannot follow. Two such defects shipped — the
 * memory kind filters and the board's assignee filters — and were found only
 * because a ratchet was taught one new shape. This asks the screen instead.
 */
const UNTRANSLATED = (keys) => `
  (() => {
    const KEYS = new Set(${JSON.stringify(keys)});
    const found = new Set();
    const shows = (el) => {
      if (!el || el.closest('.prose-mc, code, pre')) return false;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      return el.getBoundingClientRect().width > 0;
    };

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = (node.textContent || '').trim();
      if (text.length < 2 || !KEYS.has(text)) continue;
      if (shows(node.parentElement)) found.add(text);
    }

    // The names nobody sees. An untranslated one is heard, not read — and it
    // is what voice control listens for.
    for (const el of document.querySelectorAll('[aria-label], [title]')) {
      for (const attribute of ['aria-label', 'title']) {
        const value = (el.getAttribute(attribute) || '').trim();
        if (value.length < 2 || !KEYS.has(value)) continue;
        if (shows(el)) found.add(attribute + '=' + value);
      }
    }
    return [...found];
  })()
`;

const WITNESS = `(() => {
  const b = document.createElement('button');
  b.textContent = 'WITNESS';
  b.style.cssText =
    'position:absolute;left:' + (document.documentElement.clientWidth + 40) +
    'px;top:120px;width:100px;height:30px';
  document.body.append(b);
})()`;

/* ----------------------------------- Sweep -------------------------------- */

const ROUTES = [
  ['/', 'dashboard'],
  ['/workspaces', 'workspaces'],
  [`/w/${ws.id}`, 'workspace'],
  [`/w/${ws.id}/s/${session.id}`, 'session'],
  ['/board', 'board'],
  ['/memory', 'memory'],
  ['/automations', 'automations'],
  ['/agents', 'agents'],
  ['/plugins', 'plugins'],
  ['/analytics', 'analytics'],
  ['/help', 'help'],
  ['/settings', 'settings'],
];
/*
 * The dialogs, named in both languages.
 *
 * Naming them in English only made the check report "its opener exists —
 * missing from /board" nine times against a perfectly working button, because
 * the sweep also runs in French. Same family as the note in browser.mjs: a
 * check that answers a different question depending on the locale is worse
 * than no check. The names come from apps/web/src/locales/fr.ts.
 */
const DIALOGS = [
  ['/automations', { 'en-US': 'New automation', 'fr-FR': 'Nouvelle automatisation' }],
  ['/memory', { 'en-US': 'Add memory', 'fr-FR': 'Ajouter une mémoire' }],
  ['/board', { 'en-US': 'New task', 'fr-FR': 'Nouvelle tâche' }],
  ['/workspaces', { 'en-US': 'New workspace', 'fr-FR': 'Nouveau workspace' }],
  ['/memory', { 'en-US': 'Memory maintenance', 'fr-FR': 'Maintenance de la mémoire' }],
];

/**
 * Where the menus are worth opening.
 *
 * Every route would be tidier and most carry the same three from the rail, so
 * this is the set that adds something: a screen with menus of its own.
 */
const MENU_ROUTES = ['/', '/board', '/memory', '/automations', '/settings'];
const WIDTHS = [
  { name: '390', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
  { name: '768', viewport: { width: 768, height: 1024 } },
  { name: '1440', viewport: { width: 1440, height: 900 } },
];
const LOCALES = ['en-US', 'fr-FR'];

/**
 * One browser per combination, closed before the next.
 *
 * Six contexts in a row out of a single instance crashed the renderer on the
 * sixth (`Target crashed` on `newPage`, after five clean passes) — this sweep
 * loads every screen twice per combination and the memory adds up. Launching
 * costs about a second; a crash costs the whole run.
 */
const launch = () =>
  chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {},
  );

for (const locale of LOCALES) {
  for (const width of WIDTHS) {
    const browser = await launch();
    let page;
    try {
      page = await browser.newPage({ locale, ...width });
    await page.goto(`${server.baseUrl}/login`, { waitUntil: 'networkidle' });
    await page.fill('input[name="username"], #username', USERNAME);
    await page.fill('input[type="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20_000 });

    results.section(`${locale} · ${width.name}px`);

    const inspect = async (label) => {
      const r = await page.evaluate(AUDIT);
      results.check(`${label}: nothing clipped`, r.clipped.length === 0, r.clipped.join(' | '));
      results.check(`${label}: nothing covered`, r.covered.length === 0, r.covered.join(' | '));
      results.check(
        `${label}: every control is named`,
        r.unnamed.length === 0,
        [...new Set(r.unnamed)].join(' | '),
      );
      results.check(
        `${label}: no skipped heading level`,
        r.headings.length === 0,
        r.headings.join(' | '),
      );
    };

    for (const [route, label] of ROUTES) {
      await page.goto(`${server.baseUrl}${route}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(700);
      await inspect(label);

      if (locale === 'fr-FR' && route !== '/help') {
        const english = await page.evaluate(UNTRANSLATED(FRENCH_KEYS));
        results.check(
          `${label}: nothing shows in English`,
          english.length === 0,
          english.map((text) => `« ${text.slice(0, 48)} »`).join(' | '),
        );
      }

      // The witness: can this probe still fail on THIS page?
      await page.evaluate(WITNESS);
      const sabotaged = await page.evaluate(AUDIT);
      results.check(
        `${label}: the probe can fail`,
        sabotaged.clipped.some((entry) => entry.includes('WITNESS')),
        'the injected positive control was not seen — the probe proves nothing here',
      );
    }

    /*
     * Every menu on the page, opened one at a time.
     *
     * Generic on purpose: Radix marks its triggers `aria-haspopup="menu"`, so
     * this needs no per-menu wiring and cannot drift as menus are added — and
     * opening one mutates nothing, unlike clicking an arbitrary button. There
     * are 29 of them and the sweep opened none, which is a large blind spot
     * for a check whose whole subject is what a control looks like when it is
     * actually on screen.
     */
    // One menu per distinct name and width: the rail's three appear on every
    // route, and opening them five times over measures the same thing five
    // times. 456 opens became 130 with no loss of coverage, which keeps the CI
    // job inside its twenty minutes.
    const seenMenus = new Set();
    for (const route of MENU_ROUTES) {
      await page.goto(`${server.baseUrl}${route}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(600);
      const triggers = await page.$$('[aria-haspopup="menu"]');
      for (let index = 0; index < triggers.length; index += 1) {
        const trigger = triggers[index];
        if (!(await trigger.isVisible())) continue;
        const name =
          (await trigger.getAttribute('aria-label')) ||
          (await trigger.textContent())?.trim().slice(0, 24) ||
          `menu ${index}`;
        if (seenMenus.has(name)) continue;
        seenMenus.add(name);
        // Bring the trigger into view first. Radix positions a menu on its
        // trigger, so opening one that is scrolled off — a card in the board's
        // fourth column at 390px — puts the menu off-screen too, and the check
        // then reports a defect no operator could ever meet: they would have
        // scrolled to the card before reaching for its menu. Twenty failures
        // came from exactly that, all on the board, none real.
        await trigger.scrollIntoViewIfNeeded().catch(() => {});
        await page.waitForTimeout(150);
        if (!(await trigger.isVisible())) continue;

        // Radix opens on pointerdown, and a click after it *toggles the menu
        // shut* — which is how the first version of this loop inspected zero
        // menus while reporting green. One event, and then check it opened.
        await trigger.dispatchEvent('pointerdown');
        await page.waitForTimeout(400);
        if ((await page.$('[role="menu"]')) === null) continue;
        await inspect(`${route} · menu « ${name} »`);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);
      }
    }

    for (const [route, openers] of DIALOGS) {
      const opener = openers[locale];
      await page.goto(`${server.baseUrl}${route}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(600);
      const button = page.getByRole('button', { name: opener }).first();
      if ((await button.count()) === 0) {
        results.check(`dialog “${opener}”: its opener exists`, false, `missing from ${route}`);
        continue;
      }
      await button.click();
      await page.waitForTimeout(700);
      await inspect(`dialog “${opener}”`);
      await page.keyboard.press('Escape');
    }

    } catch (error) {
      // A renderer that dies mid-sweep must not take the report with it: a
      // check that reports nothing is indistinguishable from a check that
      // passed, which is the failure mode this whole file exists to avoid.
      results.check(
        `${locale} · ${width.name}px: the sweep ran to the end`,
        false,
        String(error?.message ?? error).slice(0, 140),
      );
    } finally {
      await page?.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  }
}

await server.stop();
// `finish()` prints the tally and already returns an exit code (0 or 1).
process.exit(results.finish());
