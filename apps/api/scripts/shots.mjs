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
import { mkdirSync, existsSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { PASSWORD, REPO_ROOT, startServer, USERNAME } from './harness.mjs';

const OUT = process.argv[2] ?? 'shots';
mkdirSync(OUT, { recursive: true });

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

const ws = context.workspaceRepo.create({
  name: 'Metaclaude',
  slug: 'metaclaude',
  description: 'The OS working on itself',
  path: join(server.config.workspacesDir, 'metaclaude'),
  color: '#6366f1',
  icon: 'folder',
  settings: (await import(pathToFileURL(join(REPO_ROOT, 'apps/api/dist/kernel/repositories.js')).href)).defaultWorkspaceSettings(),
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
for (const [kind, title, confidence, age] of MEMS) {
  const { memory } = await context.memory.remember({
    workspaceId: ws.id,
    kind,
    title,
    content: `${title}.`,
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
const GLOBALS = [
  ['semantic', 'The operator writes in French', 0.94, 3 * HOUR],
  ['procedural', 'Prove a new test can fail before trusting it', 0.88, 20 * HOUR],
  ['semantic', 'Never push personal infrastructure details to a repository', 0.9, 2 * DAY],
];
for (const [kind, title, confidence, age] of GLOBALS) {
  const { memory } = await context.memory.remember({
    workspaceId: null,
    kind,
    title,
    content: `${title}. Applies wherever the agent works.`,
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

async function shoot(theme, viewport, suffix) {
  // colorScheme, not localStorage: the app follows the system by default,
  // and headless Chromium's default is light.
  const page = await browser.newPage({ viewport, colorScheme: theme });
  await page.goto(`${server.baseUrl}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[name="username"], #username', USERNAME);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15_000 });

  // A third element opens a tab once the page has loaded — Radix switches on
  // mousedown, so a plain click does nothing here either.
  const screens = [
    ['/', 'dashboard'],
    ['/memory', 'memory'],
    ['/analytics', 'analytics'],
    ['/board', 'board'],
    ['/help', 'help'],
    ['/agents', 'connectors', 'MCP servers'],
    ['/settings', 'google-connection', 'Connections'],
  ];
  for (const [path, name, tab] of screens) {
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

await shoot('dark', { width: 1440, height: 900 }, '');
await shoot('light', { width: 1440, height: 900 }, '');
await shoot('dark', { width: 390, height: 844 }, '-mobile');

await browser.close();
await server.stop();
console.log(`shots written to ${OUT}`);
