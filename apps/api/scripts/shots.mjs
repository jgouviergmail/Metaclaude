/**
 * Screenshot bench: boots the real server, seeds a lived-in deployment
 * (memories with history, a day of runs, a board), and captures the key
 * screens in both themes and on a phone viewport.
 *
 * A design tool, not a check: nothing asserts, the output is for eyes.
 * Run `pnpm build` first, then `node scripts/shots.mjs <outDir>` from
 * apps/api. Needs no Claude credentials — everything is seeded server-side.
 */

import { join } from 'node:path';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { PASSWORD, REPO_ROOT, startServer, USERNAME } from './harness.mjs';

const OUT = process.argv[2] ?? 'shots';
mkdirSync(OUT, { recursive: true });

/*
 * A subset, for iterating on one screen.
 *
 * The full bench is a ten-minute run, which quietly makes it an instrument you
 * look at once at the end rather than one you design with — and a bench nobody
 * runs mid-change is how a whole redesign shipped without its screens being
 * looked at. `SHOTS_ONLY=dashboard` and `SHOTS_PASSES=dark,dark-mobile` cut it
 * to seconds. Both empty means everything, so a full run is unchanged.
 */
const ONLY = (process.env.SHOTS_ONLY ?? '').split(',').filter(Boolean);
const PASSES = (process.env.SHOTS_PASSES ?? '').split(',').filter(Boolean);
/** A pass is named by what its files are suffixed with: `dark`, `dark-mobile-fr`. */
const wanted = (theme, suffix) => PASSES.length === 0 || PASSES.includes(`${theme}${suffix}`);

const WEB_DIST = join(REPO_ROOT, 'apps', 'web', 'dist');
if (!existsSync(join(WEB_DIST, 'index.html'))) {
  console.error('Run pnpm build first.');
  process.exit(1);
}

const server = await startServer({ webDir: WEB_DIST, env: { NODE_ENV: 'production' } });
const { context } = server;

/* ------------------------------- Seed ------------------------------------ */

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const now = Date.now();

// The system workspace is Metaclaude's own and the boot has already prepared
// it; the bench dresses it as a lived-in project rather than creating a
// second one under its slug, which the unique index would refuse anyway.
const ws = context.workspaceRepo.update((await context.systemWorkspace.ensure()).id, {
  description: 'The OS working on itself',
});

// Memories with a believable spread of kinds, confidence and recency.
const MEMS = [
  ['semantic', 'The deploy pipeline gates on /healthz', 0.92, 2 * HOUR],
  ['semantic', 'CSP is script-src self — no inline scripts', 0.85, 5 * HOUR],
  ['semantic', 'Tailwind semantic tokens only, never raw palette', 0.8, 26 * HOUR],
  ['semantic', 'The audit chain orders by rowid, not timestamp', 0.74, 3 * DAY],
  ['semantic', 'Vite manual chunks pull into the entry graph', 0.55, 9 * DAY],
  ['semantic', 'ESM imports must end in .js under NodeNext', 0.68, 6 * DAY],
  ['episodic', 'Fixed the uninstall set -e trap after CI caught it', 0.88, 12 * HOUR],
  ['episodic', 'The proxy healthcheck leaked one task per probe', 0.7, 4 * DAY],
  ['episodic', 'Bundle ratchet measures +1 kB on the CI runner', 0.62, 2 * DAY],
  ['episodic', 'jgo prefers curly quotes in UI strings', 0.5, 12 * DAY],
  ['episodic', 'Radix tabs activate on mousedown in jsdom', 0.45, 20 * DAY],
  ['procedural', 'How to cut a release: changelog, bump, push, CI tag', 0.9, 8 * HOUR],
  ['procedural', 'Prove a new test can fail before trusting it', 0.86, 30 * HOUR],
  ['procedural', 'Backup restore rehearsal, step by step', 0.6, 8 * DAY],
  ['procedural', 'Rotating the master key without losing the vault', 0.4, 25 * DAY],
];
/*
 * A body that is not the title again.
 *
 * The seed used to write `content: `${title}.``, so every memory card showed
 * the same sentence twice — and a card judged on that picture looks bloated
 * for a reason the product does not have. A bench that misrepresents the thing
 * it photographs is worse than no bench: it was nearly the basis for cutting
 * the card down. Real memories carry a title you scan and a body you read.
 */
const BODY = {
  'The deploy pipeline gates on /healthz':
    'The workflow will not promote an image until /healthz answers 200 twice, thirty seconds apart. A slow first boot therefore reads as a failed deploy.',
  'CSP is script-src self — no inline scripts':
    'Anything inline is refused by the browser without a console line the app can see. Put it in apps/web/public/ and reference it by path.',
  'Tailwind semantic tokens only, never raw palette':
    'bg-surface, text-ink, border-line and the state colours. A raw palette class looks right in the dark theme and breaks the light one.',
  'The audit chain orders by rowid, not timestamp':
    'Ids carry a random suffix and several entries land in the same millisecond, so ordering by (at, id) chains onto the wrong predecessor.',
  'Vite manual chunks pull into the entry graph':
    'Naming a chunk makes index.html emit a modulepreload for it, which is the opposite of deferring it. Let the dynamic imports derive the chunks.',
  'ESM imports must end in .js under NodeNext':
    'Relative imports in apps/api and packages/shared, even when the source is TypeScript. The web app uses the bundler resolver instead.',
  'Fixed the uninstall set -e trap after CI caught it':
    'An assignment from a failing command substitution exits the script. uninstall.sh died there, after removing the units and before saving .env.',
  'The proxy healthcheck leaked one task per probe':
    'Caddy is PID 1 and does not reap, so every CMD-SHELL probe left a zombie. Five hours to hit the pids ceiling, then the container reads unhealthy forever while serving perfectly.',
  'Bundle ratchet measures +1 kB on the CI runner':
    'gzip settles differently there. The ceiling carries the headroom rather than the local figure.',
  'jgo prefers curly quotes in UI strings':
    'Apostrophes in copy are U+2019, not the ASCII one. The catalogue follows.',
  'Radix tabs activate on mousedown in jsdom':
    'fireEvent.click alone does nothing; the pointer event has to come first. Costs a red test that looks like a broken component.',
  'How to cut a release: changelog, bump, push, CI tag':
    'Write the entry into the empty [Unreleased] section, never above it. bump.mjs reads the first one it finds and refuses an empty one.',
  'Prove a new test can fail before trusting it':
    'Break the line it covers, watch it go red, put the line back. Three kernel tests were written against code that already worked.',
  'Backup restore rehearsal, step by step':
    'Stop the stack, restore into a throwaway volume, boot it, check the marker, then tear it down. Never against the live volume.',
  'Rotating the master key without losing the vault':
    'Re-encrypt every secret under the new key inside one transaction, then swap the file. A partial rotation is unrecoverable.',
};

for (const [kind, title, confidence, age] of MEMS) {
  const { memory } = await context.memory.remember({
    workspaceId: ws.id,
    kind,
    title,
    content: BODY[title] ?? `${title}.`,
    confidence,
  });
  context.db
    .prepare('UPDATE memories SET last_used_at = ?, use_count = ? WHERE id = ?')
    .run(now - age, Math.max(1, Math.round(12 * confidence)), memory.id);
}
// One pinned star.
const pinned = await context.memory.remember({
  workspaceId: ws.id,
  kind: 'semantic',
  title: 'Never push personal infrastructure details to the repo',
  content: 'Standing instruction.',
  confidence: 0.95,
  pinned: true,
});
context.db.prepare('UPDATE memories SET last_used_at = ? WHERE id = ?').run(now - HOUR, pinned.memory.id);

// The global tier, and a second workspace to put it beside.
//
// Without these the Memory page renders exactly one section and looks
// identical to the version before it was grouped — so the bench could not show
// the change it was built to judge. A screen whose new layout is invisible in
// the only place anyone looks at it is a screen nobody reviewed.
// The body says something the title does not — see the note on BODY above.
// These three sit at the top of the Memory page, so a body that restates its
// own title is the first thing anyone judging that screen reads twice.
const GLOBALS = [
  [
    'semantic',
    'The operator writes in French',
    'Replies, commit messages and UI copy in French; identifiers, file paths and command names stay as they are.',
    0.94,
    3 * HOUR,
  ],
  [
    'procedural',
    'Prove a new test can fail before trusting it',
    'Break the line it covers, watch it go red, then put the line back. A test written against code that already works proves only that the code runs.',
    0.88,
    20 * HOUR,
  ],
  [
    'semantic',
    'Never push personal infrastructure details to a repository',
    'Hostnames, IPs, key paths and account names belong in the private operations file, not in code, comments or commit messages.',
    0.9,
    2 * DAY,
  ],
];
for (const [kind, title, content, confidence, age] of GLOBALS) {
  const { memory } = await context.memory.remember({
    workspaceId: null,
    kind,
    title,
    content,
    confidence,
  });
  context.db
    .prepare('UPDATE memories SET last_used_at = ?, use_count = ? WHERE id = ?')
    .run(now - age, Math.max(2, Math.round(18 * confidence)), memory.id);
}

const sideProject = context.workspaceRepo.create({
  name: 'Chambéry',
  slug: 'chambery',
  description: 'A second project, so the tiers have something to separate',
  path: join(server.config.workspacesDir, 'chambery'),
  color: '#0ea5e9',
  icon: 'folder',
  settings: (await import(pathToFileURL(join(REPO_ROOT, 'apps/api/dist/kernel/repositories.js')).href)).defaultWorkspaceSettings(),
});
await context.memory.remember({
  workspaceId: sideProject.id,
  kind: 'semantic',
  title: 'The lease notice period is three months',
  content: 'One month inside a zone tendue; three everywhere else.',
  confidence: 0.82,
});

/*
 * The knowledge library, with a document of each shape.
 *
 * The Memory page is judged on this bench, and until now its lower half was
 * empty in every capture — so the cards nobody could see were the cards
 * nobody designed. One pasted document, one read from a real file (with its
 * format badge, its page count and its extractor), and one reaching two
 * workspaces, which is the badge the reach picker exists for.
 */
{
  const fixtures = join(REPO_ROOT, 'apps/api/src/learning/extract/fixtures');
  const { extractInProcess } = await import(
    pathToFileURL(join(REPO_ROOT, 'apps/api/dist/learning/extract/index.js')).href
  );
  const { createHash } = await import('node:crypto');

  await context.knowledge.upsert({
    workspaceId: null,
    title: 'Conventions de rédaction',
    content: [
      '# Conventions',
      '',
      '## Ton',
      "Une phrase par idée. Pas de tirets cadratins dans les messages d'erreur.",
      '',
      '## Nommage',
      'Les identifiants restent en anglais ; tout le reste est en français.',
    ].join(String.fromCharCode(10)),
    reach: { global: true, workspaceIds: [] },
  });

  for (const [name, title, reach] of [
    ['bail.docx', 'Bail — 12 rue des Lilas', { global: false, workspaceIds: [sideProject.id] }],
    ['assurance.pdf', 'Contrat multirisque habitation', { global: false, workspaceIds: [ws.id, sideProject.id] }],
  ]) {
    const data = readFileSync(join(fixtures, name));
    const extracted = await extractInProcess({ name, mime: '', data });
    const mime =
      name.endsWith('.pdf')
        ? 'application/pdf'
        : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    await context.knowledgeFiles.write(createHash('sha256').update(data).digest('hex'), mime, data);
    await context.knowledge.upsert({
      workspaceId: null,
      title,
      content: extracted.text,
      reach,
      pageBreaks: extracted.pageBreaks,
      pageUnit: extracted.pageUnit,
      source: {
        name,
        mime,
        bytes: data.length,
        extractor: extracted.extractor,
        sha256: createHash('sha256').update(data).digest('hex'),
      },
    });
  }
}

// One consolidation proposal, so the review queue shows the card it grew for.
const repeated = [];
for (const title of [
  'This workspace operates in French',
  'Card descriptions are written in French',
]) {
  const { memory } = await context.memory.remember({
    workspaceId: ws.id,
    kind: 'semantic',
    title,
    content: `${title}. Everything written here is in French.`,
    confidence: 0.76,
  });
  repeated.push(memory);
}
const { createHash } = await import('node:crypto');
const digest = (memory) =>
  createHash('sha256').update(`${memory.title}\n\n${memory.content}`).digest('hex').slice(0, 16);
context.db
  .prepare(
    `INSERT INTO insights (id, workspace_id, run_id, kind, title, body, confidence, status, payload, created_at)
     VALUES (?, ?, NULL, 'consolidation', ?, ?, 0.7, 'new', ?, ?)`,
  )
  .run(
    'insight_shots_consolidation',
    ws.id,
    '2 memories say the same thing',
    'Both state that this workspace works in French.',
    JSON.stringify({
      key: repeated.map((memory) => memory.id).sort().join('|'),
      verdict: 'duplicate',
      reason: 'Both state that this workspace works in French, in different words.',
      members: repeated.map((memory) => ({
        id: memory.id,
        title: memory.title,
        fingerprint: digest(memory),
        workspaceId: memory.workspaceId,
      })),
      winnerId: repeated[0].id,
      merged: {
        title: 'This workspace works in French',
        content: 'Everything written here — cards, commits, conversation — is in French.',
        tags: ['language'],
      },
      promotable: true,
    }),
    now - 40 * 60_000,
  );

// A day of runs for the pulse and analytics: session + runs backdated by SQL.
const session = context.sessionRepo.create({
  workspaceId: ws.id,
  title: 'Working session',
  model: 'sonnet',
  effort: 'high',
  permissionMode: 'default',
});
const PROFILE = [0,0,1,0,2,3,1,0,0,4,2,5,3,1,2,6,4,2,1,3,2,1,0,2];
let runIndex = 0;
for (let hoursAgo = 23; hoursAgo >= 0; hoursAgo -= 1) {
  const inHour = PROFILE[23 - hoursAgo] ?? 0;
  for (let i = 0; i < inHour; i += 1) {
    const run = context.runRepo.create({
      sessionId: session.id,
      workspaceId: ws.id,
      prompt: `Task ${runIndex}: tighten the ${['tests', 'docs', 'board', 'deploy'][runIndex % 4]}`,
      policy: {
        model: 'sonnet', effort: 'high', permissionMode: 'default', thinking: 'adaptive',
        thinkingBudgetTokens: null, agentName: null, ultracode: false, source: runIndex % 3 === 0 ? 'learned' : 'workspace',
      },
      triggeredBy: 'user',
      category: ['engineering', 'writing', 'ops'][runIndex % 3],
    });
    const started = now - hoursAgo * HOUR - (i * 9 + 3) * 60_000;
    const failed = runIndex % 7 === 3;
    const usage = JSON.stringify({
      inputTokens: 12_000, outputTokens: 3_500, cacheReadTokens: 0, cacheWriteTokens: 0,
      costUsd: 0.02 + (runIndex % 5) * 0.01, durationMs: 4 * 60_000, numTurns: 6,
    });
    context.db
      .prepare(`UPDATE runs SET status = ?, started_at = ?, finished_at = ?, usage = ? WHERE id = ?`)
      .run(failed ? 'failed' : 'succeeded', started, started + 4 * 60_000, usage, run.id);
    runIndex += 1;
  }
}

/*
 * A transcript worth photographing.
 *
 * The bench created runs but never any events, so the session screen — the one
 * with the composer, the tool cards and the approvals — was always the empty
 * state. Judging `TranscriptItem`, `ToolCallCard` and `Delegation` by eye was
 * therefore impossible, which is how a whole lot's worth of density went
 * unlooked-at. A user message, a reply with prose and code, and a tool call is
 * enough to see the rhythm.
 */
const lastRun = context.runRepo.listBySession(session.id).at(-1);
if (lastRun) {
  const TRANSCRIPT = [
    {
      kind: 'user_message',
      attachments: [],
      text: 'Reprends la mise en page du board : les colonnes débordent sur un téléphone.',
    },
    {
      // `thinking`, not `assistant_thinking`: the schema in `domain.ts` names it
      // that, and the wrong name was written here and accepted in silence — the
      // row landed, the screen ignored it, and it looked exactly like the
      // preference being off. Read the schema rather than the neighbour's name.
      kind: 'thinking',
      text: 'The columns are fixed-width and the row does not scroll. Check the container first.',
    },
    {
      kind: 'tool_call',
      name: 'Read',
      status: 'ok',
      input: JSON.stringify({ file_path: 'apps/web/src/pages/BoardPage.tsx' }),
      result: 'const COLUMNS = [...] // 5 columns at 288px each',
    },
    {
      kind: 'assistant_text',
      streaming: false,
      text: `Le conteneur est en \`flex\` sans \`overflow-x\`, donc les cinq colonnes à 288px débordent dès 390px de large.

\`\`\`tsx
<div className="flex gap-3 overflow-x-auto">
\`\`\`

Cela rend le défilement horizontal explicite plutôt que subi.`,
    },
  ];
  TRANSCRIPT.forEach((event, seq) => {
    context.transcriptRepo.append(session.id, {
      ...event,
      id: `evt_shot${seq}`,
      runId: lastRun.id,
      seq,
      at: now - 240_000 + seq * 1000,
    });
  });
}

// Policy arms with distinct shapes: settled, promising-but-uncertain, poor.
const ARMS = [
  ['engineering', 'sonnet', 'high', 34, 8, 40],
  ['engineering', 'opus', 'max', 4, 2, 5],
  ['engineering', 'haiku', 'low', 3, 6, 8],
  ['writing', 'sonnet', 'medium', 12, 3, 14],
  ['writing', 'haiku', 'low', 6, 5, 10],
  ['ops', 'sonnet', 'high', 9, 2, 10],
];
const insertArm = context.db.prepare(
  `INSERT INTO policy_arms (id, workspace_id, category, model, effort, alpha, beta, trials, total_reward, mean_cost_usd, mean_duration_ms, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
let armIndex = 0;
for (const [category, model, effort, alpha, betaV, trials] of ARMS) {
  // Global scope: the Analytics default view reads workspace_id IS NULL.
  insertArm.run(`pol_seed${armIndex}`, null, category, model, effort, alpha, betaV, trials, alpha, 0.02 + armIndex * 0.01, 150_000, now);
  armIndex += 1;
}

// A board with cards across columns.
const { BoardService } = await import(pathToFileURL(join(REPO_ROOT, 'apps/api/dist/services/board.js')).href);
const board = new BoardService(context.db);
const CARDS = [
  ['backlog', 'Draw the constellation legend on mobile'],
  ['backlog', 'Investigate the flaky socket reconnect'],
  ['todo', 'Ship the aesthetic pass'],
  ['todo', 'Write the release notes for 0.26'],
  ['in_progress', 'Polish the pulse hero'],
  ['review', 'Beta curves in Analytics'],
  ['done', 'Fix the iOS tab bar'],
];
for (const [status, title] of CARDS) {
  board.create({ workspaceId: ws.id, title, createdBy: 'user:jules', status }, 'user:jules');
}

/* ----------------------------- Capture ----------------------------------- */

const executablePath = process.env.PLAYWRIGHT_CHROMIUM;
const browser = await chromium.launch(executablePath ? { executablePath } : {});

async function shoot(theme, viewport, suffix, options = {}) {
  if (!wanted(theme, suffix)) return;
  const { density = 'compact', locale = 'en-US' } = options;
  // colorScheme, not localStorage: the app follows the system by default,
  // and headless Chromium's default is light. The locale is pinned for the
  // same reason: the interface follows the browser, the bench's selectors
  // are English, and a French machine otherwise stops at the first tab name.
  const page = await browser.newPage({ viewport, colorScheme: theme, locale });
  /*
   * The density is a stored preference, read before first paint by
   * `public/density-init.js`. `addInitScript` runs before the page's own
   * scripts, which is the only moment that works.
   */
  await page.addInitScript((value) => {
    try {
      // Both keys, and that is the whole trap. `metaclaude.density` is the
      // standalone one the pre-paint script reads to stamp the attribute, so
      // writing only it moves the *spacing* and nothing else; the disclosure
      // that shows help outright in the comfortable density reads the zustand
      // store under `metaclaude.ui`. The first capture of this dimension showed
      // a comfortable screen with every explanation still folded, which is the
      // compact one wearing more air.
      localStorage.setItem('metaclaude.density', value);
      localStorage.setItem(
        'metaclaude.ui',
        JSON.stringify({ state: { density: value }, version: 1 }),
      );
    } catch {
      // Private mode: the stylesheet's default is compact, which is what
      // this branch would have set anyway.
    }
  }, density);
  await page.goto(`${server.baseUrl}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[name="username"], #username', USERNAME);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15_000 });

  // A third element opens a tab once the page has loaded — Radix switches on
  // mousedown, so a plain click does nothing here either.
  const screens = [
    ['/', 'dashboard'],
    ['/workspaces', 'workspaces'],
    [`/w/${ws.id}`, 'workspace'],
    [`/w/${ws.id}/s/${session.id}`, 'session'],
    ['/memory', 'memory'],
    ['/analytics', 'analytics'],
    ['/board', 'board'],
    ['/automations', 'automations'],
    ['/help', 'help'],
    ['/server', 'server'],
    ['/agents', 'skills', 'Skills'],
    ['/agents', 'connectors', 'MCP servers'],
    ['/agents', 'library', 'Library'],
    /*
     * Settings' groups are routes now, not tabs — so the French pass reaches
     * them. They used to need a tab opened by its English name, which is the
     * whole reason the French pass skipped them, and it skipped exactly the
     * screens where the longest copy sits.
     */
    ['/settings/appearance', 'settings-appearance'],
    ['/settings/security', 'settings-security'],
    ['/settings/connections', 'settings-connections'],
    ['/settings/configuration', 'settings-configuration'],
    ['/settings/audit', 'settings-audit'],
  ];
  for (const [path, name, tab] of screens) {
    if (ONLY.length && !ONLY.includes(name)) continue;
    /*
     * A tab is opened by its *name*, and the names are English.
     *
     * `shoot` pins the locale for exactly that reason, so the French pass has
     * to skip the screens that need one rather than carry a second table of
     * selectors that would drift from the catalogue. What it still shows is
     * every plain route — the dashboard, the board, a session — which is where
     * the longest copy lives anyway.
     */
    if (tab && locale !== 'en-US') continue;
    await page.goto(`${server.baseUrl}${path}`, { waitUntil: 'networkidle' });
    if (tab) {
      const trigger = page.getByRole('tab', { name: tab });
      await trigger.dispatchEvent('mousedown');
      await trigger.click();
      await page.waitForTimeout(600);
    }
    await page.waitForTimeout(900);
    await page.screenshot({ path: join(OUT, `${name}-${theme}${suffix}.png`) });
    // The app scrolls inside <main>'s scroller, so a second capture at the
    // bottom shows what the viewport shot cannot.
    const scrolled = await page.evaluate(() => {
      const scroller = [...document.querySelectorAll('.overflow-y-auto')][0];
      if (!scroller || scroller.scrollHeight <= scroller.clientHeight) return false;
      scroller.scrollTop = scroller.scrollHeight;
      return true;
    });
    if (scrolled) {
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(OUT, `${name}-${theme}${suffix}-end.png`) });
    }
  }
  await page.close();
}

/**
 * The dialogs, on a phone.
 *
 * The pages were captured from the first day and the dialogs never were —
 * which is where every setting an operator changes actually lives, and where
 * a row of controls has the least room. It cost a real defect: four trigger
 * buttons in one flex row overflowed the automation dialog at 390px, so the
 * fourth was off-screen and an event trigger could not be chosen on a phone.
 * Nothing here asserts; the output is for eyes, like the rest of this bench.
 */
async function shootDialogs(theme, viewport, suffix) {
  if (!wanted(theme, `${suffix}-dialogs`)) return;
  const page = await browser.newPage({ viewport, colorScheme: theme, locale: 'en-US' });
  await page.goto(`${server.baseUrl}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[name="username"], #username', USERNAME);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15_000 });

  // [path, name, the control that opens it, and a tab to reach first]
  const dialogs = [
    ['/automations', 'dialog-automation', 'New automation'],
    ['/memory', 'dialog-memory', 'Add memory'],
    ['/board', 'dialog-task', 'New task'],
  ];
  /*
   * The command palette is deliberately absent, and this note is so nobody
   * spends the afternoon adding it again.
   *
   * It opens on Ctrl+K, the dialog mounts — `[role="dialog"]` is there — and a
   * headless capture shows the dimmed page with nothing on it, at half a second
   * and at a second and a half. Shipping that picture would be worse than
   * having none: an empty overlay filed under `dialog-palette` looks exactly
   * like coverage.
   *
   * It matters because a mechanical size pass once put a font size on the
   * palette's *container* rather than on the heading its variants target, and
   * every command inherited 10.5px. Nothing failed — a class list is not a
   * place a test looks, and no guard reaches a dialog opened by a shortcut.
   * That one was found by reading the diff.
   */

  for (const [path, name, opener] of dialogs) {
    await page.goto(`${server.baseUrl}${path}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(700);
    const button = page.getByRole('button', { name: opener }).first();
    if ((await button.count()) === 0) {
      console.warn(`shots: no "${opener}" on ${path} — dialog not captured`);
      continue;
    }
    await button.click();
    await page.waitForTimeout(700);
    await page.screenshot({ path: join(OUT, `${name}-${theme}${suffix}.png`) });

    // A dialog scrolls inside itself; the settings that overflow are usually
    // below the fold, which is the half a viewport shot never shows.
    const scrolled = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const scroller = dialog?.querySelector('.overflow-y-auto') ?? dialog;
      if (!scroller || scroller.scrollHeight <= scroller.clientHeight) return false;
      scroller.scrollTop = scroller.scrollHeight;
      return true;
    });
    if (scrolled) {
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(OUT, `${name}-${theme}${suffix}-end.png`) });
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }
  await page.close();
}

await shoot('dark', { width: 1440, height: 900 }, '');
await shoot('light', { width: 1440, height: 900 }, '');
await shoot('dark', { width: 390, height: 844 }, '-mobile');
/*
 * The two dimensions the bench never photographed.
 *
 * `comfortable` is the setting's entire point — more air, and the help shown
 * outright — and eleven lots changed what it does without a single picture of
 * it. French is the longest copy in the narrowest frame, which is where every
 * layout defect of this redesign was found; `scripts/responsive.mjs` measures
 * its geometry, and geometry is not the same question as whether it reads.
 *
 * The full matrix is sixteen runs of a dozen screens. These two answer the
 * question the other thirteen would only repeat.
 */
await shoot('dark', { width: 390, height: 844 }, '-mobile-comfortable', {
  density: 'comfortable',
});
/*
 * And comfortable on a desk, which is where it is actually chosen.
 *
 * The setting was photographed on a phone only, and a phone is one column
 * whatever the density — so the pass that existed showed the smallest half of
 * what the setting does. The dashboard's two columns, a settings screen's
 * sections and a table's rows are where the extra air either reads as room or
 * as a page that will not fit; none of it had ever been looked at.
 */
await shoot('dark', { width: 1440, height: 900 }, '-comfortable', {
  density: 'comfortable',
});
await shoot('dark', { width: 390, height: 844 }, '-mobile-fr', { locale: 'fr-FR' });
await shootDialogs('dark', { width: 390, height: 844 }, '-mobile');
await shootDialogs('dark', { width: 1440, height: 900 }, '');

await browser.close();
await server.stop();
console.log(`shots written to ${OUT}`);
