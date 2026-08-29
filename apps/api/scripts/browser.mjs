/**
 * Live browser check.
 *
 * Serves the production web build from the API's own static handler and drives
 * it in a real Chromium — so the CSP, the cookie flags, the socket handshake
 * and the responsive layout are all exercised the way a deployment does them,
 * ending with a real agent run typed into the real composer.
 *
 * Needs a built web app and an authenticated Claude CLI:
 *
 *     pnpm build
 *     pnpm --filter @metaclaude/api check:browser
 *
 * Chromium is found via `PLAYWRIGHT_CHROMIUM` or Playwright's own resolution.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { AGENT_CHECKS_ENABLED, PASSWORD, REPO_ROOT, Results, startServer, USERNAME } from './harness.mjs';

const WEB_DIST = join(REPO_ROOT, 'apps', 'web', 'dist');
if (!existsSync(join(WEB_DIST, 'index.html'))) {
  console.error(`No built web app at ${WEB_DIST}. Run \`pnpm build\` first.`);
  process.exit(1);
}

const results = new Results();
const server = await startServer({ webDir: WEB_DIST, env: { NODE_ENV: 'production' } });

const executablePath = process.env.PLAYWRIGHT_CHROMIUM;
const browser = await chromium.launch(executablePath ? { executablePath } : {});

/**
 * Every page here is opened in English, deliberately.
 *
 * The app picks its language from `navigator.language` when nothing is stored,
 * and several assertions below name an English control — `aria-label="Send"`
 * among them. On a French machine the button is `Envoyer` and the check failed
 * while the composer worked perfectly: a check that answers a different
 * question depending on the developer's locale is worse than no check. The
 * language itself has its own coverage in the component tests.
 */
const LOCALE = { locale: 'en-US' };

/**
 * Collect anything that should never happen: a failed request, a page error, a
 * console error. A pre-login 401 on the session probe is excluded — that is the
 * app asking "is anyone signed in?", and the answer is the 401.
 */
function watch(page) {
  const problems = [];
  page.on('response', (response) => {
    const { pathname } = new URL(response.url());
    if (pathname === '/api/auth/me' && response.status() === 401) return;
    if (response.status() >= 400) problems.push(`http ${response.status()} ${pathname}`);
  });
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('Failed to load resource')) {
      problems.push(`console: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  return problems;
}

async function login(page) {
  await page.goto(`${server.baseUrl}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[name="username"], #username', USERNAME);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15_000 });
}

/* -------------------------------------------------------------------------- */

results.section('desktop (1440×900)');
{
  const page = await browser.newPage({ ...LOCALE, viewport: { width: 1440, height: 900 } });
  const problems = watch(page);

  await page.goto(`${server.baseUrl}/`, { waitUntil: 'networkidle' });
  results.check('an anonymous visit lands on the login screen', page.url().includes('/login'));
  results.check('the login form renders', (await page.locator('input[type="password"]').count()) === 1);

  await login(page);
  results.check('login navigates into the app', !page.url().includes('/login'));

  await page.waitForTimeout(1200);
  results.check('nothing failed after login', problems.length === 0, problems.slice(0, 3).join(' | '));
  results.check('the shell paints', (await page.evaluate(() => document.body.innerText.length)) > 40);

  // `script-src 'self'` means the theme bootstrap has to live in its own file;
  // an inline script would be blocked and the page would flash the wrong theme.
  const inline = await page.evaluate(
    () => [...document.querySelectorAll('script')].filter((s) => !s.src && s.textContent.trim()).length,
  );
  results.check('no inline script survives the CSP', inline === 0);

  await page.close();
}

results.section('every top-level route');
{
  const page = await browser.newPage({ ...LOCALE, viewport: { width: 1440, height: 900 } });
  const problems = watch(page);
  await login(page);

  for (const path of ['/', '/automations', '/memory', '/agents', '/analytics', '/settings']) {
    problems.length = 0;
    await page.goto(`${server.baseUrl}${path}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    const length = await page.evaluate(() => document.body.innerText.trim().length);
    results.check(`${path} renders content`, length > 40, `${length} chars`);
    results.check(`${path} logs nothing`, problems.length === 0, problems.slice(0, 2).join(' | '));
  }
  await page.close();
}

results.section('phone (375×812)');
{
  const page = await browser.newPage({
    ...LOCALE,
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
  });
  const problems = watch(page);
  await login(page);
  await page.waitForTimeout(800);

  const overflow = () =>
    page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  results.check('no horizontal overflow', (await overflow()) <= 1);

  await page.goto(`${server.baseUrl}/settings`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  results.check('settings fits too', (await overflow()) <= 1);

  /*
   * Tap targets, measured by *hit area* rather than by painted box.
   *
   * The small button sizes stay visually compact — a 28px icon button is right
   * for a dense desktop row — and widen their target under `pointer: coarse`
   * with an inset pseudo-element. `getBoundingClientRect` cannot see that, so
   * the probe asks the question that matters: does a thumb landing here hit the
   * control? Each candidate is scrolled into view first, because
   * `elementFromPoint` answers `null` outside the viewport and would otherwise
   * pass everything below the fold.
   */
  const undersized = await page.evaluate(async () => {
    const settle = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const reaches = (el, x, y) => {
      const hit = document.elementFromPoint(x, y);
      return hit !== null && (hit === el || el.contains(hit));
    };

    const failures = [];
    for (const el of document.querySelectorAll('button, a[href], [role="button"]')) {
      let rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.height >= 32 && rect.width >= 32) continue;

      el.scrollIntoView({ block: 'center', inline: 'center' });
      await settle();
      rect = el.getBoundingClientRect();

      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const ok =
        reaches(el, cx, cy) &&
        reaches(el, cx, cy - 15) &&
        reaches(el, cx, cy + 15) &&
        reaches(el, cx - 15, cy) &&
        reaches(el, cx + 15, cy);
      if (!ok) {
        const label = el.getAttribute('aria-label') ?? el.textContent.trim().slice(0, 20);
        failures.push(`${el.tagName}[${label}] ${Math.round(rect.width)}×${Math.round(rect.height)}`);
      }
    }
    return failures;
  });
  results.check('every small control has a 32px hit area', undersized.length === 0, undersized.join(' | '));
  results.check('the phone view logs nothing', problems.length === 0, problems.slice(0, 2).join(' | '));

  await page.close();
}

results.section('a real run, driven from the UI');
{
  const page = await browser.newPage({ ...LOCALE, viewport: { width: 1440, height: 900 } });
  const problems = watch(page);
  await login(page);

  const workspace = await page.evaluate(async () => {
    const csrf = decodeURIComponent(
      document.cookie.split('; ').find((c) => c.startsWith('mc_csrf='))?.split('=')[1] ?? '',
    );
    const response = await fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-metaclaude-csrf': csrf },
      body: JSON.stringify({ name: 'Browser Lab' }),
    });
    return (await response.json()).workspace;
  });
  results.check('a workspace is created from the browser', Boolean(workspace?.id));

  await page.goto(`${server.baseUrl}/w/${workspace.id}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  const composer = page.locator('textarea').first();
  results.check('the composer is present', (await composer.count()) === 1);

  if (AGENT_CHECKS_ENABLED) {
    await composer.fill('Reply with exactly the word NAVIGATEUR-OK and nothing else.');
    await composer.press('Meta+Enter');

    const appeared = await page
      .waitForFunction(() => document.body.innerText.includes('NAVIGATEUR-OK'), { timeout: 180_000 })
      .then(() => true)
      .catch(() => false);
    results.check('the agent reply appears in the transcript', appeared);

    // The reply streams before the run terminates — reflexion and the bandit
    // update after the last token — so wait for the state, not a fixed delay.
    const settled = await page
      .waitForFunction(
        () =>
          [...document.querySelectorAll('button, [role="button"]')].every(
            (el) => !/^stop$/i.test(el.textContent.trim()),
          ),
        { timeout: 60_000 },
      )
      .then(() => true)
      .catch(() => false);
    results.check('the run reaches a terminal state and the Stop control goes away', settled);
  } else {
    results.skip('a live agent run from the UI', 'no Claude credentials (METACLAUDE_E2E_NO_AGENT)');
    // Typing still has to work, so at least prove the composer accepts input
    // and offers a usable Send control.
    await composer.fill('a prompt that is never sent');
    const sendable = await page.evaluate(() =>
      [...document.querySelectorAll('button')].some(
        (el) => el.getAttribute('aria-label') === 'Send' && !el.disabled,
      ),
    );
    results.check('the composer accepts input and offers Send', sendable);
  }
  results.check('the session view logs nothing', problems.length === 0, problems.slice(0, 3).join(' | '));

  await page.close();
}

const code = results.finish();
await browser.close();
await server.stop();
process.exit(code);
