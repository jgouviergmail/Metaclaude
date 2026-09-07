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
import { tmpdir } from 'node:os';
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
/*
 * Pin the Claude credential state, because the screens depend on it.
 *
 * `readCliLogin` reads CLAUDE_CONFIG_DIR, falling back to the *host's* home
 * directory — so on a developer machine that is signed in, the dashboard's
 * "Claude is not authenticated" panel never renders, and everything inside it
 * goes unaudited. That is not hypothetical: a link in that panel shipped with
 * no hit area, this guard passed locally with 1065 checks, and CI — which has
 * no credentials — failed on it. The local run was answering a smaller
 * question than the one that gates a push.
 *
 * Pointed at a directory that does not exist, so both machines audit the same
 * screen. Nothing here ever runs an agent; the seed writes to the database
 * directly.
 */
process.env.CLAUDE_CONFIG_DIR = join(tmpdir(), 'metaclaude-responsive-no-credentials');

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

    const out = { counted: 0, clipped: [], excused: 0, unnamed: [], covered: [], headings: [], tapTargets: [] };
    const candidates = [];
    // Only under a coarse pointer, because that is the only place the inset
    // pseudo-elements exist: a mouse keeps the precise 20px target.
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    const small = [];

    for (const el of document.querySelectorAll(SEL)) {
      if (inert(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const s = getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none' || s.opacity === '0') continue;
      /*
       * Ask the platform whether it is visible, not three properties.
       *
       * The connections panel folds its Google card into a closed details, and
       * Chrome hides those contents with content-visibility rather than with
       * display — which none of the three checks above can see. The audit then
       * measured a Copy button nobody could reach and reported it covered by
       * the empty state painted over it, at a different subset per width. Not a
       * defect of the app: a blind spot of the probe.
       */
      if (el.checkVisibility && !el.checkVisibility({
        contentVisibilityAuto: true,
        opacityProperty: true,
        visibilityProperty: true,
      })) continue;
      if (el.closest('details:not([open])')) continue;
      out.counted += 1;
      if (!nameOf(el)) out.unnamed.push('<' + el.tagName.toLowerCase() + '> .' + String(el.className).slice(0, 44));
      if (rect.right > VW + 1 || rect.left < -1) {
        const v = verdict(el);
        if (v.scrollable) out.excused += 1;
        else out.clipped.push(short(el) + ' [' + Math.round(rect.left) + '..' + Math.round(rect.right) + ']/' + VW + '  <- ' + v.who);
        continue;
      }
      if (coarse && (rect.width < 32 || rect.height < 32)) small.push(el);
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
    /*
     * What a small control OFFERS a thumb, which is not what it wins.
     *
     * The app grows a control with an inset pseudo-element rather than with
     * its box: a 28px button still measures 28 and 44px of screen answers to
     * it. So the painted rectangle says nothing, and the first version of this
     * asked the screen instead — elementFromPoint, 15px above and below the
     * centre, the rule browser.mjs uses.
     *
     * That rule cannot be used here. It reported eighteen failures of which
     * most were not defects: adjacent controls' hit areas OVERLAP by design,
     * the later one in the DOM wins the contested point, and two swatches of a
     * colour grid can no more both answer 15px apart than they can occupy the
     * same pixel. The overlap is the documented reason TOUCH_TARGET_Y exists.
     * browser.mjs gets away with it on six routes where no small control has a
     * close neighbour; this guard opens the dialogs, where they all do.
     *
     * Reading the pseudo-element's own outward extension answers the question
     * actually being asked — did anyone give this control a hit area — and a
     * neighbour cannot change the answer. A label wrapping the control is the
     * other honest way to be tappable, so a control inside one that is itself
     * tall enough is excused.
     */
    const offered = (el) => {
      const box = el.getBoundingClientRect();
      const pseudo = getComputedStyle(el, '::before');
      let height = box.height;
      if (pseudo.content && pseudo.content !== 'none' && pseudo.position === 'absolute') {
        const top = parseFloat(pseudo.top);
        const bottom = parseFloat(pseudo.bottom);
        // Negative insets reach outward; a positive one is decoration inside.
        if (top < 0) height -= top;
        if (bottom < 0) height -= bottom;
      }
      return height;
    };
    for (const el of small) {
      if (offered(el) >= 30) continue;
      /*
       * A checkbox is 16px and its label is the target: pressing the words
       * toggles it. That is a hit area, differently spelled.
       *
       * el.labels and not only closest('label'), and the difference is a false
       * positive this rule produced against itself. The app labels a checkbox
       * with htmlFor, so the label is a *sibling*, not an ancestor — and the
       * obvious fix, putting the inset pseudo-element on the input, does
       * nothing at all: ::before does not render on a replaced element. The
       * rule would have demanded a change that could not work, to a control
       * whose whole row is already tappable.
       */
      const labels = [...(el.labels ?? []), el.closest('label')].filter(Boolean);
      // Measured the same way as the control itself: a label is one line of
      // text and grows with the same pseudo-element, so reading its painted
      // box would reject the very fix the rule is asking for.
      if (labels.some((label) => offered(label) >= 30)) continue;
      const box = el.getBoundingClientRect();
      out.tapTargets.push(
        short(el) + ' ' + Math.round(box.width) + 'x' + Math.round(box.height) +
        ' offers ' + Math.round(offered(el)),
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
/*
 * Menus are opened on every route, not on five of twelve.
 *
 * The cost is small because the loop already skips a name it has opened at
 * this width: the rail's three appear everywhere and are opened once. What the
 * five-route list actually excluded was every menu unique to the other seven —
 * the workspace's, the session's, the plugin rows' — which is precisely the set
 * no other check looks at.
 */
const MENU_ROUTES = ROUTES.map(([route]) => route);

/**
 * The routes whose menus are worth pressing item by item.
 *
 * Every list screen, and nothing else: a dialog behind a menu item belongs to a
 * row. `/w/:id/s/:id` is here because a session's own header menu holds the two
 * panel toggles and its deletion.
 */
const MENU_DIALOG_ROUTES = new Set([
  '/workspaces',
  '/board',
  '/memory',
  '/automations',
  '/agents',
  '/plugins',
  `/w/${ws.id}`,
  `/w/${ws.id}/s/${session.id}`,
]);
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
/**
 * The five invariants, asked of whatever is on screen.
 *
 * Taken out of the sweep's loop because the dialog pass below runs outside it,
 * and two copies of five checks is two chances for them to drift apart.
 */
function inspector(page) {
  return async (label) => {
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
    // Empty at the two pointer-fine widths: the rule only asks the question
    // where the answer can differ from the painted box.
    results.check(
      `${label}: every small control answers a thumb`,
      r.tapTargets.length === 0,
      [...new Set(r.tapTargets)].join(' | '),
    );
  };
}

const launch = () =>
  chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {},
  );

for (const locale of LOCALES) {
  for (const width of WIDTHS) {
    const browser = await launch();
    let page;
    try {
      /*
       * Animations off, and not for speed.
       *
       * The tab sweep reported "nothing covered" against three controls of the
       * connections panel — a different subset at each width, which is the
       * signature of a race rather than of a defect: the empty state fading out
       * still sat over the form the audit was measuring. A geometry probe
       * measures the layout at rest, and a control covered only mid-animation
       * is not a defect an operator can meet. The app honours the preference
       * with `!important` overrides, so this genuinely stops the motion rather
       * than merely asking.
       *
       * A flaky check is worse than no check: it teaches you to read past red.
       */
      page = await browser.newPage({ locale, reducedMotion: 'reduce', ...width });
    await page.goto(`${server.baseUrl}/login`, { waitUntil: 'networkidle' });
    await page.fill('input[name="username"], #username', USERNAME);
    await page.fill('input[type="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20_000 });

    results.section(`${locale} · ${width.name}px`);

    const inspect = inspector(page);

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

      /*
       * Every tab panel, not only the one the screen opens on.
       *
       * Seventeen exist and this swept three — the default of each tabbed
       * screen — so fourteen were audited by nobody. That is not a hypothetical
       * gap: the agents screen's tab strip was full-bleed above a centred panel
       * for six lots, its connector directory filled a phone with prose, and
       * both were found by eye on a screenshot because the sweep only ever saw
       * the Skills tab.
       *
       * Radix switches on `mousedown`, not on click; the triggers stay mounted
       * across a switch, but they are re-queried each time rather than held,
       * because a panel that re-renders its own strip would invalidate a handle
       * and the loop would silently inspect nothing.
       */
      const tabCount = (await page.$$('[role="tab"]')).length;
      for (let index = 0; index < tabCount; index += 1) {
        const tab = (await page.$$('[role="tab"]'))[index];
        if (!tab || !(await tab.isVisible())) continue;
        if ((await tab.getAttribute('aria-selected')) === 'true') continue;
        const name =
          (await tab.getAttribute('aria-label')) ||
          (await tab.textContent())?.trim().slice(0, 28) ||
          `tab ${index}`;
        await tab.scrollIntoViewIfNeeded().catch(() => {});
        await tab.dispatchEvent('mousedown');
        // A panel that fetches must have answered before it is measured, or the
        // audit's two passes see two different pages.
        await page.waitForLoadState('networkidle').catch(() => {});
        await page.waitForTimeout(450);
        if ((await tab.getAttribute('aria-selected')) !== 'true') continue;
        const panelLabel = `${label} · onglet « ${name} »`;
        await inspect(panelLabel);
        if (locale === 'fr-FR' && route !== '/help') {
          const english = await page.evaluate(UNTRANSLATED(FRENCH_KEYS));
          results.check(
            `${panelLabel}: nothing shows in English`,
            english.length === 0,
            english.map((text) => `« ${text.slice(0, 48)} »`).join(' | '),
          );
        }
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


/*
 * The dialog pass, outside the sweep and after it.
 *
 * It runs inside the loop no longer, and the reason is determinism rather than
 * tidiness: pressing every button on every route changes the seeded server —
 * a run starts, a token is issued — and it used to run in the fourth of six
 * combinations, so two of them audited a deployment the pass had modified. One
 * real defect surfaced that way and it could as easily have been a phantom.
 * Nothing follows it now.
 *
 * At the phone width, in French, once per name: that is where a dialog breaks,
 * the widest copy in the narrowest frame. Running the full matrix would triple
 * a nine-minute sweep for combinations that have never held a defect the phone
 * did not.
 *
 * Measured, because the second phase is not free: the button sweep alone runs
 * the whole guard in 480s, pressing menu items as well takes it to 703s, and
 * this job is allowed twenty minutes. That buys three dialogues nothing else
 * reaches — an automation's edit form and two confirmations — and the mechanism
 * for any added later. Restricting the item sweep to the list screens saved 72s
 * of it; reading the item names on the first open, which looked like the
 * obvious saving, saved seven seconds and disproved its own theory.
 */
{
  const browser = await launch();
  try {
    const page = await browser.newPage({
      locale: 'fr-FR',
      reducedMotion: 'reduce',
      ...WIDTHS[0],
    });
    const inspect = inspector(page);
    /*
     * Signing in, and signing in again.
     *
     * The menu sweep presses every item, and one of them is `Sign out` — which
     * ends the session the whole pass depends on. Naming that item in a deny
     * list would rot the day another one ends a session; noticing that we are
     * back on the login screen does not. Without this the first route logged
     * itself out and the remaining eleven audited the login page, reporting a
     * confident zero dialogues.
     */
    const signIn = async () => {
      await page.goto(`${server.baseUrl}/login`, { waitUntil: 'networkidle' });
      await page.fill('input[name="username"], #username', USERNAME);
      await page.fill('input[type="password"]', PASSWORD);
      await page.click('button[type="submit"]');
      await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20_000 });
    };
    await page.goto(`${server.baseUrl}/login`, { waitUntil: 'networkidle' });
    await page.fill('input[name="username"], #username', USERNAME);
    await page.fill('input[type="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20_000 });
    results.section('dialogues · fr-FR · 390px');

/*
 * Every other dialog, found rather than named.
 *
 * Fifty-two exist and the list above names five. Naming the rest is not a
 * list anyone would keep true — a dialog added next month would be
 * unaudited and nothing would say so — so the openers are discovered: click
 * a button, and if a dialog appeared, audit it and press Escape. A confirm
 * dialog is a dialog too, and cancelling one is exactly what Escape does,
 * so a "Delete" button is safe to press and worth pressing.
 *
 * At the phone width, in French, and once per name. That is where a dialog
 * breaks: the widest copy in the narrowest frame, which is how the
 * automation dialog was found with two of its presets behind the footer.
 * Running the full matrix would multiply a seven-minute sweep by three for
 * combinations that have never held a defect the phone did not.
 *
 * Discovery runs last, after the routes and the menus, so whatever a click
 * changes on the seeded server cannot reach an audit that has not run yet.
 */
  const seenDialogs = new Set();
  for (const [route, label] of ROUTES) {
    await page.goto(`${server.baseUrl}${route}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    const count = (await page.$$('button')).length;
    for (let index = 0; index < count; index += 1) {
      const button = (await page.$$('button'))[index];
      if (!button) continue;
      if (!(await button.isVisible()) || !(await button.isEnabled())) continue;
      // A menu trigger opens a menu, which the loop above already audits.
      if (await button.getAttribute('aria-haspopup')) continue;
      if ((await button.getAttribute('role')) === 'tab') continue;
      const name = (
        (await button.getAttribute('aria-label')) ||
        (await button.textContent())?.trim() ||
        ''
      )
        .replace(/[\s]+/g, ' ')
        .slice(0, 40);
      if (!name || seenDialogs.has(name)) continue;

      /*
       * Dismiss whatever the previous click announced.
       *
       * A toast left over from one button was still on screen when the next
       * one opened a dialog, and the audit reported its close button as
       * covered — by the dialog that had just opened over it. That is an
       * artefact of pressing every button in a row, not something an
       * operator meets, and a check that reports it is reporting on the
       * probe rather than on the app.
       */
      for (const close of await page.$$('[data-sonner-toast] button')) {
        await close.click({ timeout: 500 }).catch(() => {});
      }

      const before = page.url();
      await button.scrollIntoViewIfNeeded().catch(() => {});
      await button.click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(450);

      const dialog = await page.$('[role="dialog"]');
      if (dialog) {
        seenDialogs.add(name);
        await inspect(`${label} · dialogue « ${name} »`);
        const english = await page.evaluate(UNTRANSLATED(FRENCH_KEYS));
        results.check(
          `${label} · dialogue « ${name} »: nothing shows in English`,
          english.length === 0,
          english.map((text) => `« ${text.slice(0, 48)} »`).join(' | '),
        );
        await page.keyboard.press('Escape');
        await page.waitForTimeout(250);
      }
      // A button that navigated, or one that left a dialog open: put the
      // page back where the loop expects it, or every button after this one
      // is clicked on the wrong screen.
      if (page.url() !== before || (await page.$('[role="dialog"]'))) {
        await page.goto(`${server.baseUrl}${route}`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(400);
      }
    }

    /*
     * The dialogs behind a menu item, which pressing buttons never reaches.
     *
     * Sixteen of fifty-two were found by the sweep above; the rest open from a
     * row's overflow menu — rename, move, archive, confirm a deletion. That is
     * where an operator meets them, and nothing had ever audited one.
     *
     * A menu closes when an item is chosen, so each item costs its own reopen.
     * Deduplicated by item name across the whole pass, because the rail's menus
     * repeat on every route and opening `Sign out` twelve times measures the
     * same thing twelve times.
     */
    /*
     * Only the screens that carry a *row* menu.
     *
     * A dialog behind a menu item is opened from a list: an automation's
     * overflow, a memory's, a session's. The rail's three menus are the same on
     * every route, and opening them twelve times to read names nobody will
     * press again cost most of a five-minute increase — measured, after an
     * optimisation that read the names on the first open saved seven seconds
     * and disproved the cheaper theory.
     */
    const triggers = MENU_DIALOG_ROUTES.has(route) ? await page.$$('[aria-haspopup="menu"]') : [];
    for (let index = 0; index < triggers.length; index += 1) {
      const openMenu = async () => {
        const trigger = (await page.$$('[aria-haspopup="menu"]'))[index];
        if (!trigger || !(await trigger.isVisible())) return false;
        await trigger.scrollIntoViewIfNeeded().catch(() => {});
        await page.waitForTimeout(120);
        // Radix opens on pointerdown; a click after it toggles the menu shut.
        await trigger.dispatchEvent('pointerdown');
        await page.waitForTimeout(320);
        return (await page.$('[role="menu"]')) !== null;
      };

      if (!(await openMenu())) continue;
      const ITEMS = '[role="menuitem"], [role="menuitemcheckbox"]';
      /*
       * The names are read on the *first* open, and only an unseen one costs a
       * reopen.
       *
       * Reopening for every item and checking the name afterwards spent five
       * minutes of every run on menus whose entries had all been pressed on an
       * earlier route — the rail's three appear on all twelve. Same reasoning
       * as the menu loop above deduplicating by name, one level in.
       */
      const names = [];
      for (const entry of await page.$$(ITEMS)) {
        names.push(((await entry.textContent()) ?? '').replace(/[\s]+/g, ' ').trim().slice(0, 40));
      }
      await page.keyboard.press('Escape');
      await page.waitForTimeout(150);

      for (let item = 0; item < names.length; item += 1) {
        const name = names[item];
        if (!name || seenDialogs.has(name)) continue;
        if (!(await openMenu())) break;
        const entry = (await page.$$(ITEMS))[item];
        if (!entry) {
          await page.keyboard.press('Escape');
          continue;
        }

        const before = page.url();
        await entry.click({ timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(500);

        if (await page.$('[role="dialog"]')) {
          seenDialogs.add(name);
          await inspect(`${label} · menu → dialogue « ${name} »`);
          const english = await page.evaluate(UNTRANSLATED(FRENCH_KEYS));
          results.check(
            `${label} · menu → dialogue « ${name} »: nothing shows in English`,
            english.length === 0,
            english.map((text) => `« ${text.slice(0, 48)} »`).join(' | '),
          );
        }
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);
        if (new URL(page.url()).pathname.startsWith('/login')) await signIn();
        if (page.url() !== before || (await page.$('[role="dialog"]'))) {
          await page.goto(`${server.baseUrl}${route}`, { waitUntil: 'networkidle' });
          await page.waitForTimeout(400);
        }
      }
    }
  }
  results.check(
    'the dialog sweep found more than the five that are named',
    seenDialogs.size > 5,
    `found ${seenDialogs.size}`,
  );


  } catch (error) {
    results.check(
      'the dialog pass ran to the end',
      false,
      String(error?.message ?? error).slice(0, 140),
    );
  } finally {
    await browser.close();
  }
}

// The dialog pass above is the last thing that needs the server.
await server.stop();

// `finish()` prints the tally and already returns an exit code (0 or 1).
process.exit(results.finish());
