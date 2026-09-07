/**
 * Which text fields do not use the width they are given.
 *
 * An `<input>` has an intrinsic width — the `size` attribute defaults to about
 * twenty characters — and it wins wherever nothing overrides it. The result is
 * a form whose fields are all slightly different lengths for no reason anyone
 * chose, which reads as carelessness long before anyone can say why.
 *
 * Reports every field narrower than 90% of the block it sits in, with what it
 * is and where. A one-off, like the other rulers here:
 * `node scripts/measure-inputs.mjs` from apps/api, after a build.
 */

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { PASSWORD, REPO_ROOT, startServer, USERNAME } from './harness.mjs';

const WEB_DIST = join(REPO_ROOT, 'apps', 'web', 'dist');
if (!existsSync(join(WEB_DIST, 'index.html'))) {
  console.error('Run pnpm build first.');
  process.exit(1);
}

const ROUTES = [
  '/',
  '/workspaces',
  '/board',
  '/memory',
  '/server',
  '/automations',
  '/agents',
  '/plugins',
  '/analytics',
  '/settings/appearance',
  '/settings/security',
  '/settings/connections',
  '/settings/configuration',
  '/settings/audit',
  '/help',
];

/** Below this a field is not using the room it was given. */
// 0.8 rather than 0.9: a field sharing a flex row with its own button sits
// around 83% and that is the row working, not a defect.
const FILL = 0.8;

const server = await startServer({ webDir: WEB_DIST, env: { NODE_ENV: 'production' } });
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
});

const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  colorScheme: 'dark',
  locale: 'en-US',
});
await page.goto(`${server.baseUrl}/login`, { waitUntil: 'networkidle' });
await page.fill('input[name="username"], #username', USERNAME);
await page.fill('input[type="password"]', PASSWORD);
await page.click('button[type="submit"]');
await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15_000 });

let short = 0;
let total = 0;

for (const path of ROUTES) {
  await page.goto(`${server.baseUrl}${path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);

  const fields = await page.evaluate((fill) => {
    const out = [];
    const els = document.querySelectorAll('input:not([type=checkbox]):not([type=radio]), textarea, select');
    for (const el of els) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      /*
       * The room a field has, which is not always the widest ancestor.
       *
       * Walking up until something is wider finds the *page* when a field sits
       * in a grid column — and a two-column form or a 220px sidebar is the
       * layout doing its job, not a field losing its width. So the walk stops
       * at the first element that is itself an item of a flex or grid parent:
       * that item is what the layout allocated, and filling it is all a field
       * can be asked to do. Without this the probe reported four defects that
       * were all deliberate columns.
       */
      const laidOut = (node) => {
        const p = node.parentElement;
        if (!p) return false;
        // Grid only, deliberately. A grid track is width the layout *assigned*
        // — a two-column form, a 220px sidebar — and filling it is all a field
        // can do. A flex item is different: it shrinks to its content unless
        // told otherwise, which is the defect this probe exists to find.
        // Accepting flex here made the probe blind to the very bug it had just
        // measured: with `Label` sabotaged back, it reported zero.
        return getComputedStyle(p).display.includes('grid');
      };
      let node = el;
      while (
        node.parentElement &&
        !laidOut(node) &&
        node.parentElement.getBoundingClientRect().width <= box.width + 1
      ) {
        node = node.parentElement;
      }
      const parent = laidOut(node) ? node : node.parentElement;
      const room = parent ? parent.getBoundingClientRect().width : box.width;
      const ratio = room > 0 ? box.width / room : 1;
      if (ratio >= fill) continue;
      // A number field is deliberately short — `4` does not need 720 pixels,
      // and indicting it buries the fields that genuinely lost their width.
      if (el.getAttribute('type') === 'number') continue;
      out.push({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') ?? '',
        name: el.id || el.getAttribute('name') || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '(sans nom)',
        width: Math.round(box.width),
        room: Math.round(room),
        ratio: Math.round(ratio * 100),
      });
    }
    return out;
  }, FILL);

  const seen = await page.evaluate(
    () => document.querySelectorAll('input:not([type=checkbox]):not([type=radio]), textarea, select').length,
  );
  total += seen;
  short += fields.length;

  if (fields.length > 0) {
    console.log(`\n${path}`);
    for (const f of fields) {
      console.log(
        `  ${String(f.ratio).padStart(3)}%  ${String(f.width).padStart(4)}px of ${String(f.room).padStart(4)}px  ` +
          `${f.tag}${f.type ? `[${f.type}]` : ''}  ${f.name}`,
      );
    }
  }
}

console.log(`\n${short} champ(s) sous ${Math.round(FILL * 100)}% de leur place, sur ${total} visibles`);

await browser.close();
await server.stop();
