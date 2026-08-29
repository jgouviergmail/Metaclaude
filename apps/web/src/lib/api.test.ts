/**
 * The API client's one shared contract: `request` serialises the body.
 *
 * This file exists because of a bug that reached production. `createApiToken`
 * passed `JSON.stringify(body)` — which `request` then stringified again, so
 * the API received a JSON *string* where its schema wanted an object and
 * answered "expected object, received string". Every end-to-end test of that
 * feature was green, because they all call `fetch` directly and never go
 * through this file. The screen that mints a token was the only caller, and it
 * was broken on arrival.
 *
 * Two tests, at two altitudes: one reads the source for the mistake in any
 * caller, present or future, and one drives the client to prove what actually
 * reaches the wire. The second is what makes the first more than a lint rule.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from './api';

describe('the body is serialised exactly once', () => {
  /**
   * A structural read, because the failure is invisible at the call site: both
   * spellings compile, both type-check, and the wrong one only shows up as a
   * schema error from the server.
   *
   * `import(…?raw)` and `new URL(…, import.meta.url)` do not work under vitest
   * (CLAUDE.md records why), so the source is read from disk relative to the
   * package root.
   */
  it('no caller stringifies its own body', () => {
    const source = readFileSync('src/lib/api.ts', 'utf8');

    // One occurrence is legitimate and expected: `request` itself, which is
    // the whole reason no caller may do it too.
    const occurrences = source.match(/body: JSON\.stringify\(/g) ?? [];
    expect(
      occurrences.length,
      'only `request` may serialise the body; a caller that does it too encodes it twice',
    ).toBe(1);
    expect(source).toContain('{ body: JSON.stringify(options.body) }');
  });
});

describe('what actually reaches the wire', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ token: {}, secret: 'mck_x' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends a token request the server can parse as an object', async () => {
    await api.createApiToken({
      name: 'n8n',
      scopes: ['run'],
      workspaceIds: ['ws_1'],
      ceiling: 'plan',
      expiresInDays: 30,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed: unknown = JSON.parse(init.body as string);

    // The assertion the production bug would have failed: parsing the payload
    // once must yield an object, not another JSON string to parse again.
    expect(typeof parsed).toBe('object');
    expect(parsed).toMatchObject({ name: 'n8n', scopes: ['run'], expiresInDays: 30 });
    expect(init.headers).toMatchObject({ 'content-type': 'application/json' });
  });
});

/**
 * Every path the client calls is a route the API actually registers.
 *
 * This is the other half of the failure that shipped in 0.38.0. One half was
 * the client mangling its own body, caught by the cases above; the other is the
 * client and the server disagreeing about *where* something lives — a renamed
 * route, a `POST` the API declares as `PATCH`, a typo in a path that only shows
 * up as a 404 in production, on the one screen nobody tested by hand.
 *
 * Deliberately structural rather than a live round trip: importing the server
 * into the web app's test environment would couple two packages that are
 * separate on purpose, and a check that reads both sides costs nothing and
 * cannot flake. What it cannot see is a payload the route rejects — that is
 * what the API's own edge tests are for.
 */
describe('the client and the API agree on where things live', () => {
  /** `/api/x/${id}/y` and `/api/x/:id/y` are the same route. */
  const normalise = (path: string): string =>
    path
      // `qs({ … })` appends the query string and is always in the tail; its
      // own braces are what a naive `${…}` match trips over.
      .replace(/\$\{qs\(.*$/, '')
      .replace(/\$\{[^{}]*\}/g, ':p')
      .replace(/:[a-zA-Z]+/g, ':p')
      .replace(/\/+$/, '');

  const routes = (): Set<string> => {
    const dir = 'src/../../api/src/routes';
    const found = new Set<string>();
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.ts') || file.includes('.test.')) continue;
      const source = readFileSync(`${dir}/${file}`, 'utf8');
      // `app.get('/api/…')`, `app.post<{ Params: … }>('/api/…')`, and the
      // loop form `app[method]('/api/…')` the gateway uses.
      for (const match of source.matchAll(/app(?:\.\w+|\[\w+\])(?:<[^>]*>)?\(\s*'([^']+)'/g)) {
        found.add(normalise(match[1]!));
      }
    }
    return found;
  };

  const calls = (): string[] => {
    const source = readFileSync('src/lib/api.ts', 'utf8');
    const found = new Set<string>();
    for (const match of source.matchAll(/['`](\/api\/[^'`]*)['`]/g)) {
      // Query strings are appended by `qs()`; the route is what precedes them.
      found.add(normalise(match[1]!.split('?')[0]!));
    }
    return [...found];
  };

  it('reaches only routes the API registers', () => {
    const declared = routes();
    const called = calls();

    // A check that finds nothing passes vacuously, which is the day it stops
    // guarding. Both sides are large and known to be.
    expect(declared.size).toBeGreaterThan(50);
    expect(called.length).toBeGreaterThan(50);

    const missing = called.filter((path) => !declared.has(path));
    expect(missing, 'the client calls paths the API does not register').toEqual([]);
  });
});
