/**
 * How much of a phone screen is navigation before any content.
 *
 * Every System screen carries the section strip; the board carries a filter
 * bar. Stacked under the header, that is chrome on chrome — a real cost on a
 * 844px-tall phone, and one no guard reports because nothing is clipped,
 * covered or overflowing.
 *
 * Measured as the sum of the fixed bands `<main>` places above its content:
 * the header, any nav, and any direct child that draws a bottom rule. An
 * earlier version took "the top of the first vertical scroller" instead and
 * reported 179px for the board against 118 on the screenshot — the board's
 * first vertical scroller is inside a *column*, so the figure silently
 * included a column header. A measure that cannot be checked against a
 * picture is not a measure.
 *
 * A one-off, like `measure-tabbar.mjs`: run it when the navigation changes.
 * `node scripts/measure-chrome.mjs` from apps/api, after a build.
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
  ['/', 'dashboard'],
  ['/workspaces', 'workspaces'],
  ['/board', 'board'],
  ['/memory', 'memory'],
  ['/automations', 'automations'],
  ['/agents', 'agents'],
  ['/plugins', 'plugins'],
  ['/analytics', 'analytics'],
  ['/help', 'help'],
  ['/settings', 'settings'],
];

const server = await startServer({ webDir: WEB_DIST, env: { NODE_ENV: 'production' } });
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
});

const VIEWPORT = { width: 390, height: 844 };
const page = await browser.newPage({ viewport: VIEWPORT, colorScheme: 'dark', locale: 'fr-FR' });
await page.goto(`${server.baseUrl}/login`, { waitUntil: 'networkidle' });
await page.fill('input[name="username"], #username', USERNAME);
await page.fill('input[type="password"]', PASSWORD);
await page.click('button[type="submit"]');
await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15_000 });

console.log(`viewport ${VIEWPORT.width}x${VIEWPORT.height}, fr-FR\n`);
console.log(`${'route'.padEnd(14)} ${'chrome'.padStart(7)}  share  bands`);

const rows = [];
for (const [path, name] of ROUTES) {
  await page.goto(`${server.baseUrl}${path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);

  const measured = await page.evaluate(() => {
    const main = document.querySelector('main');
    if (!main) return null;
    // The fixed bands above the content: the page header, any navigation, and
    // any direct child of <main> that rules itself off from what follows.
    const bands = [...main.children].filter((el) => {
      const r = el.getBoundingClientRect();
      if (r.height === 0) return false;
      const tag = el.tagName.toLowerCase();
      if (tag === 'header' || tag === 'nav') return true;
      const cls = typeof el.className === 'string' ? el.className : '';
      return cls.includes('border-b') || el.querySelector(':scope > header, :scope > nav') !== null;
    });
    return {
      chrome: Math.round(bands.reduce((sum, el) => sum + el.getBoundingClientRect().height, 0)),
      bands: bands.length,
    };
  });

  if (!measured) continue;
  if (measured.bands === 0) {
    // Zero bands is not zero chrome: it means the filter above did not
    // recognise this screen's bands. Say so rather than report a flattering
    // number nobody can check against a screenshot.
    console.log(name.padEnd(14) + '      -  non mesurable (aucune bande reconnue)');
    continue;
  }
  const share = Math.round((measured.chrome / VIEWPORT.height) * 100);
  rows.push({ name, ...measured, share });
  console.log(
    `${name.padEnd(14)} ${String(measured.chrome).padStart(6)}px  ${String(share).padStart(3)}%  ${measured.bands}`,
  );
}

const worst = rows.reduce((a, b) => (b.chrome > a.chrome ? b : a));
console.log(`\nworst: ${worst.name} at ${worst.chrome}px (${worst.share}% of the screen)`);

await browser.close();
await server.stop();
