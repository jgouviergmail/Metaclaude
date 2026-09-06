/**
 * Shared harness for the live checks.
 *
 * Both scripts boot the *real* server against a throwaway data directory, so
 * what they exercise is the deployed code path — the same guards, the same
 * migrations, the same static handler and CSP — rather than a test double.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pino from 'pino';

const HERE = dirname(fileURLToPath(import.meta.url));
export const API_ROOT = resolve(HERE, '..');
export const REPO_ROOT = resolve(API_ROOT, '..', '..');

export const USERNAME = 'jules';
export const PASSWORD = 'a-long-enough-passphrase-9';

/** Tally of results, printed at the end and used as the exit code. */
export class Results {
  passed = 0;
  failed = 0;
  skipped = 0;

  check(label, ok, detail = '') {
    if (ok) {
      this.passed += 1;
      console.log(`  ok   ${label}`);
    } else {
      this.failed += 1;
      console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
    }
    return Boolean(ok);
  }

  /**
   * Record something deliberately not run.
   *
   * Counted and printed rather than silently omitted: a suite that quietly
   * shrinks reads as a passing suite, which is how a check stops being run for
   * a year without anyone noticing.
   */
  skip(label, why) {
    this.skipped += 1;
    console.log(`  skip ${label} — ${why}`);
  }

  section(title) {
    console.log(`\n=== ${title} ===`);
  }

  finish() {
    const tail = this.skipped > 0 ? `, ${this.skipped} skipped` : '';
    console.log(`\n${this.passed} passed, ${this.failed} failed${tail}`);
    return this.failed === 0 ? 0 : 1;
  }
}

/**
 * Whether the checks that need a live agent should run.
 *
 * CI has no Claude credentials, so it runs everything else. This is explicit
 * rather than inferred from a missing token: an accidentally-unset token on a
 * developer's machine should fail loudly, not silently halve the suite.
 */
export const AGENT_CHECKS_ENABLED =
  process.env.METACLAUDE_E2E_NO_AGENT !== '1' && !process.argv.includes('--no-agent');

/**
 * Boot a server on an ephemeral port with an owner account already created.
 *
 * @param {{ webDir?: string; env?: Record<string, string> }} options
 */
export async function startServer(options = {}) {
  // A `file://` URL, not a path. Node's ESM loader reads `D:\...` as a URL
  // with the scheme `d:` and refuses it, so every live check here was
  // unrunnable on Windows — which is why they had never been run on one.
  const dist = pathToFileURL(join(API_ROOT, 'dist')).href;
  const { loadConfig } = await import(`${dist}/config.js`);
  const { createAppContext } = await import(`${dist}/context.js`);
  const { buildServer } = await import(`${dist}/server.js`);

  const dataRoot = mkdtempSync(join(tmpdir(), 'metaclaude-check-'));

  const config = loadConfig({
    NODE_ENV: 'test',
    METACLAUDE_DATA_DIR: join(dataRoot, 'data'),
    METACLAUDE_WORKSPACES_DIR: join(dataRoot, 'workspaces'),
    METACLAUDE_WEB_DIR: options.webDir ?? join(dataRoot, 'web'),
    // The checks run over plain http on loopback, so the Secure flag would stop
    // the browser storing the session cookie at all.
    METACLAUDE_INSECURE_COOKIES: 'true',
    METACLAUDE_PORT: '8787',
    METACLAUDE_RUN_TIMEOUT_MS: '180000',
    // The retrieval knobs pass through when the caller set them: CI runs the
    // live check once against the shipped model, from a fetched cache.
    ...Object.fromEntries(
      ['METACLAUDE_EMBEDDINGS', 'METACLAUDE_EMBEDDING_MODEL', 'METACLAUDE_EMBEDDING_CACHE']
        .filter((key) => process.env[key])
        .map((key) => [key, process.env[key]]),
    ),
    ...options.env,
  });

  const context = await createAppContext(config, pino({ level: 'error' }));
  await context.auth.createUser({ username: USERNAME, password: PASSWORD, role: 'owner' });

  const app = await buildServer(context);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address();

  return {
    context,
    config,
    app,
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/api/ws`,
    async stop() {
      await app.close();
      await context.shutdown?.();
      /*
       * A throwaway directory that will not delete must not take the report
       * with it.
       *
       * Windows holds the SQLite file open for a moment after close, so
       * `rmSync` raised EPERM — after every check had passed, and before
       * `finish()` could print the tally. A run whose checks were green then
       * exited non-zero with no report at all, which is the exact failure this
       * file's own comment forbids: a check that reports nothing is
       * indistinguishable from a check that passed.
       *
       * `maxRetries` covers the ordinary case; the catch covers the rest, and
       * says so on stderr rather than pretending the directory is gone. The
       * operating system reclaims a temp directory anyway.
       */
      try {
        rmSync(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch (error) {
        process.stderr.write(`  note  could not remove ${dataRoot}: ${error?.code ?? error}
`);
      }
    },
  };
}

/**
 * A cookie-keeping HTTP client, because the whole auth design rests on the
 * pairing of the httpOnly session cookie with the readable CSRF one.
 */
export class Client {
  #cookies = new Map();
  csrfToken = '';

  constructor(baseUrl) {
    this.baseUrl = baseUrl;
  }

  get cookieHeader() {
    return [...this.#cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  async call(path, { method = 'GET', body, headers = {} } = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(this.#cookies.size > 0 ? { cookie: this.cookieHeader } : {}),
        ...(this.csrfToken ? { 'x-metaclaude-csrf': this.csrfToken } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    for (const raw of response.headers.getSetCookie()) {
      const [name, value] = raw.split(';')[0].split('=');
      this.#cookies.set(name, value);
      if (name === 'mc_csrf') this.csrfToken = decodeURIComponent(value);
    }

    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not every response is JSON */
    }
    return { status: response.status, body: json, text };
  }

  login(username = USERNAME, password = PASSWORD) {
    return this.call('/api/auth/login', { method: 'POST', body: { username, password } });
  }
}

/** Poll until `predicate` holds, or give up. */
export async function until(predicate, { timeoutMs = 10_000, everyMs = 20, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}
