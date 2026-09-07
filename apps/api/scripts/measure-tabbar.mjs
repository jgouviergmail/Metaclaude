/**
 * How much room the phone tab bar's labels actually have.
 *
 * A sixth section makes each cell 390/6 = 65px, and `Dashboard` at 11.5px is
 * close to that. Nothing in `scripts/responsive.mjs` reports it: the text is
 * not clipped (it fits its own cell), nothing overlaps, and no ancestor
 * overflows — a label that ends 2px from its neighbour is legal and unreadable
 * at the same time. So this measures the gutter between one label's right edge
 * and the next label's left edge, in both languages, and prints the tightest.
 *
 * A one-off rather than a check: run it when the tab bar gains or loses an
 * entry. `node scripts/measure-tabbar.mjs` from apps/api, after a build.
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

/** Below this the labels read as one run-on string rather than six entries. */
const COMFORTABLE_GUTTER = 8;

const server = await startServer({ webDir: WEB_DIST, env: { NODE_ENV: 'production' } });
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
});

let worst = { gutter: Infinity };

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
  await page.waitForTimeout(600);

  const measured = await page.evaluate(() => {
    const bar = [...document.querySelectorAll('nav[aria-label]')].find((nav) =>
      nav.className.includes('fixed'),
    );
    if (!bar) return null;
    // The label is the tab's last text node; measure it with a Range, which
    // gives the ink rather than the flex cell it sits in.
    return [...bar.querySelectorAll('a')].map((tab) => {
      const text = [...tab.childNodes].find((n) => n.nodeType === Node.TEXT_NODE);
      const range = document.createRange();
      range.selectNodeContents(text ?? tab);
      const ink = range.getBoundingClientRect();
      const cell = tab.getBoundingClientRect();
      return {
        label: (text?.textContent ?? '').trim(),
        cell: Math.round(cell.width),
        ink: Math.round(ink.width),
        left: Math.round(ink.left),
        right: Math.round(ink.right),
      };
    });
  });

  console.log(`\n${locale} — viewport 390px`);
  for (const [i, tab] of measured.entries()) {
    const next = measured[i + 1];
    const gutter = next ? next.left - tab.right : null;
    const flag = gutter !== null && gutter < COMFORTABLE_GUTTER ? '  <-- tight' : '';
    console.log(
      `  ${tab.label.padEnd(12)} cell ${String(tab.cell).padStart(3)}px  ` +
        `ink ${String(tab.ink).padStart(3)}px  ` +
        `gutter ${gutter === null ? '  —' : String(gutter).padStart(3) + 'px'}${flag}`,
    );
    if (gutter !== null && gutter < worst.gutter) {
      worst = { gutter, locale, between: `${tab.label} / ${next.label}` };
    }
  }
  await page.close();
}

console.log(
  `\ntightest gutter: ${worst.gutter}px (${worst.locale}, between ${worst.between})` +
    `  — comfortable is ${COMFORTABLE_GUTTER}px or more`,
);

await browser.close();
await server.stop();
