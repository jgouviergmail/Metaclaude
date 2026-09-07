/**
 * Which page titles are truncated on a phone.
 *
 * `truncate` is doing exactly what it is for, so nothing reports this: no
 * control is clipped, nothing overflows, no ancestor scrolls. The title is
 * simply the thing that loses, because it is the flexible item in a row whose
 * buttons are not — and the title is the only thing on screen saying which
 * page you are on. Measured on Automations in French: `Aut…`, three
 * characters, because "Nouvelle automatisation" is a wide button.
 *
 * Compares the `h1`'s rendered width against the width its text wants. Run
 * `node scripts/measure-titles.mjs` from apps/api, after a build.
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
  '/help',
];

const server = await startServer({ webDir: WEB_DIST, env: { NODE_ENV: 'production' } });
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
});

let cut = 0;

for (const locale of ['en-US', 'fr-FR']) {
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    colorScheme: 'dark',
    locale,
  });
  await page.goto(`${server.baseUrl}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[name="username"], #username', USERNAME);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15_000 });

  console.log(`\n${locale}`);
  for (const path of ROUTES) {
    await page.goto(`${server.baseUrl}${path}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);

    const measured = await page.evaluate(() => {
      const h1 = document.querySelector('main h1') ?? document.querySelector('h1');
      if (!h1) return null;
      // What the text wants, measured with a Range so padding and the
      // truncation itself do not enter into it.
      const range = document.createRange();
      range.selectNodeContents(h1);
      return {
        text: (h1.textContent ?? '').trim(),
        shown: Math.round(h1.getBoundingClientRect().width),
        wants: Math.round(range.getBoundingClientRect().width),
      };
    });

    if (!measured) continue;
    // A Range on a truncated element reports the *shown* width, so compare the
    // element against its own scrollWidth instead — that is what overflows.
    const truncated = await page.evaluate(() => {
      const h1 = document.querySelector('main h1') ?? document.querySelector('h1');
      return h1 ? h1.scrollWidth > h1.clientWidth + 1 : false;
    });

    if (truncated) {
      cut += 1;
      console.log(`  CUT  ${path.padEnd(22)} ${measured.shown}px shown  "${measured.text}"`);
    }
  }
  await page.close();
}

console.log(`\n${cut} titre(s) tronque(s) a 390px`);

await browser.close();
await server.stop();
