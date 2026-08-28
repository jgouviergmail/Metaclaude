import { describe, expect, it, vi } from 'vitest';

import { GOOGLE_GRANTS } from '@metaclaude/shared';

import type { FetchLike } from './oauth.js';
import { buildGoogleServer, parseGrants } from './server.js';
import { EXPIRY_SKEW_MS, TokenCache } from './token-cache.js';
import { ALL_GOOGLE_TOOLS, googleTools } from './tools.js';

/* -------------------------------------------------------------------------- */

describe('which tools a connection exposes', () => {
  it('registers nothing when nothing was granted', () => {
    // A tool that is not registered is not in the model's tool list at all, so
    // the agent cannot try it and cannot report that "sending mail failed".
    expect(googleTools([])).toEqual([]);
  });

  it('gives read-only Gmail exactly the reading tools', () => {
    const names = googleTools(['gmail.read']).map((tool) => tool.name);
    expect(names).toEqual(['gmail_search', 'gmail_read']);
    expect(names).not.toContain('gmail_send');
  });

  it('keeps sending behind its own grant', () => {
    expect(googleTools(['gmail.send']).map((t) => t.name)).toEqual(['gmail_send']);
  });

  it('does not leak calendar or drive into a mail-only connection', () => {
    const names = googleTools(['gmail.read', 'gmail.send']).map((tool) => tool.name);
    expect(names.some((name) => name.startsWith('calendar_'))).toBe(false);
    expect(names.some((name) => name.startsWith('drive_'))).toBe(false);
  });

  it('exposes everything when everything is granted', () => {
    expect(googleTools(GOOGLE_GRANTS)).toHaveLength(ALL_GOOGLE_TOOLS.length);
  });

  it('requires only grants that exist in the shared vocabulary', () => {
    for (const tool of ALL_GOOGLE_TOOLS) {
      expect(tool.requires.length, `${tool.name} requires nothing`).toBeGreaterThan(0);
      for (const grant of tool.requires) {
        expect(GOOGLE_GRANTS, `${tool.name} requires "${grant}"`).toContain(grant);
      }
    }
  });

  it('describes every tool well enough for a model to choose it', () => {
    for (const tool of ALL_GOOGLE_TOOLS) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(tool.description.length, `${tool.name}: too thin`).toBeGreaterThanOrEqual(60);
    }
  });
});

describe('reading the grants off the command line', () => {
  it('parses the list the parent passed', () => {
    expect(parseGrants(['node', 'main.js', '--grants', 'gmail.read,calendar.write'])).toEqual([
      'gmail.read',
      'calendar.write',
    ]);
  });

  it('drops anything that is not a grant, rather than trusting the string', () => {
    // The argument is configuration, but a grant that was removed from the
    // vocabulary must not come back as a live capability.
    expect(parseGrants(['--grants', 'gmail.read,drive.everything,,gmail.read'])).toEqual([
      'gmail.read',
      'gmail.read',
    ]);
  });

  it('returns nothing when the flag is absent or empty', () => {
    expect(parseGrants(['node', 'main.js'])).toEqual([]);
    expect(parseGrants(['--grants'])).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */

function tokenFetch(responses: Array<{ ok?: boolean; body: unknown }>) {
  let index = 0;
  const calls: string[] = [];
  const impl: FetchLike = async (url, init) => {
    calls.push(url);
    const next = responses[Math.min(index++, responses.length - 1)]!;
    return {
      ok: next.ok ?? true,
      status: next.ok === false ? 400 : 200,
      text: async () => JSON.stringify(next.body),
    };
  };
  return { impl, calls };
}

describe('the access-token cache', () => {
  const deps = { clientId: 'c', clientSecret: 's', refreshToken: 'rt' };

  it('mints once and reuses until the token is nearly expired', async () => {
    let clock = 1_000_000;
    const { impl, calls } = tokenFetch([{ body: { access_token: 'at-1', expires_in: 3600 } }]);
    const cache = new TokenCache({ ...deps, fetchImpl: impl, now: () => clock });

    expect(await cache.get()).toBe('at-1');
    clock += 3600_000 - EXPIRY_SKEW_MS - 1;
    expect(await cache.get()).toBe('at-1');
    expect(calls).toHaveLength(1);
  });

  it('renews before Google would call the token expired', async () => {
    // Renewing exactly at expiry means a token that was valid when the request
    // was built is expired when Google reads it.
    let clock = 1_000_000;
    const { impl, calls } = tokenFetch([
      { body: { access_token: 'at-1', expires_in: 3600 } },
      { body: { access_token: 'at-2', expires_in: 3600 } },
    ]);
    const cache = new TokenCache({ ...deps, fetchImpl: impl, now: () => clock });

    await cache.get();
    clock += 3600_000 - EXPIRY_SKEW_MS;
    expect(await cache.get()).toBe('at-2');
    expect(calls).toHaveLength(2);
  });

  it('collapses concurrent callers onto one refresh', async () => {
    // Three tool calls arriving together must not become three refreshes:
    // Google rate-limits them and two results would be discarded.
    const { impl, calls } = tokenFetch([{ body: { access_token: 'at-1', expires_in: 3600 } }]);
    const cache = new TokenCache({ ...deps, fetchImpl: impl });

    const tokens = await Promise.all([cache.get(), cache.get(), cache.get()]);

    expect(tokens).toEqual(['at-1', 'at-1', 'at-1']);
    expect(calls).toHaveLength(1);
  });

  it('lets the next caller retry after a failed refresh', async () => {
    // Without clearing the in-flight promise, every later call awaits one that
    // already rejected and the server never recovers.
    const { impl } = tokenFetch([
      { ok: false, body: { error: 'invalid_grant' } },
      { body: { access_token: 'at-2', expires_in: 3600 } },
    ]);
    const cache = new TokenCache({ ...deps, fetchImpl: impl });

    await expect(cache.get()).rejects.toThrow(/invalid_grant/);
    expect(await cache.get()).toBe('at-2');
  });

  it('mints again after being invalidated', async () => {
    const { impl, calls } = tokenFetch([
      { body: { access_token: 'at-1', expires_in: 3600 } },
      { body: { access_token: 'at-2', expires_in: 3600 } },
    ]);
    const cache = new TokenCache({ ...deps, fetchImpl: impl });

    await cache.get();
    cache.invalidate();
    expect(await cache.get()).toBe('at-2');
    expect(calls).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */

/** Reach into the SDK's registry so the wiring can be checked without stdio. */
function registeredNames(server: ReturnType<typeof buildGoogleServer>): string[] {
  const registry = (server as unknown as { _registeredTools: Record<string, unknown> })
    ._registeredTools;
  return Object.keys(registry).sort();
}

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

/**
 * Call a registered tool's handler directly — no transport, no protocol.
 *
 * `handler` is the SDK's own field name (1.30); an earlier draft guessed
 * `callback`, which is only the name of the *argument* that sets it. Reaching
 * into a private registry is a deliberate trade: the alternative is standing
 * up a stdio pair to test whether a 401 is retried.
 */
async function invokeTool(
  server: ReturnType<typeof buildGoogleServer>,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const registry = (
    server as unknown as {
      _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<ToolResult> }>;
    }
  )._registeredTools;
  const tool = registry[name];
  if (!tool) throw new Error(`"${name}" is not registered`);
  return tool.handler(args, {});
}

describe('the server as the CLI sees it', () => {
  const version = '9.9.9';

  it('registers exactly the granted tools', () => {
    const server = buildGoogleServer({
      grants: ['calendar.read'],
      fetchImpl: (async () => ({ ok: true, status: 200, text: async () => '{}' })) as FetchLike,
      tokens: new TokenCache({
        fetchImpl: (async () => ({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ access_token: 'at', expires_in: 3600 }),
        })) as FetchLike,
        clientId: 'c',
        clientSecret: 's',
        refreshToken: 'rt',
      }),
      version,
    });

    expect(registeredNames(server)).toEqual(['calendar_list_events']);
  });

  it('registers nothing at all for an empty grant set', () => {
    const server = buildGoogleServer({
      grants: [],
      fetchImpl: (async () => ({ ok: true, status: 200, text: async () => '{}' })) as FetchLike,
      tokens: new TokenCache({
        fetchImpl: (async () => ({ ok: true, status: 200, text: async () => '{}' })) as FetchLike,
        clientId: 'c',
        clientSecret: 's',
        refreshToken: 'rt',
      }),
      version,
    });
    expect(registeredNames(server)).toEqual([]);
  });

  it('retries once when Google says the access token is dead, then succeeds', async () => {
    // An access token can die before its stated expiry — a password change, a
    // revoked session. One silent retry with a fresh token turns that into a
    // hiccup rather than a failed run.
    let apiCalls = 0;
    const api: FetchLike = async () => {
      apiCalls += 1;
      if (apiCalls === 1) {
        return {
          ok: false,
          status: 401,
          text: async () => JSON.stringify({ error: { message: 'Invalid Credentials' } }),
        };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ items: [] }) };
    };
    let minted = 0;
    const tokenSource: FetchLike = async () => {
      minted += 1;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ access_token: `at-${minted}`, expires_in: 3600 }),
      };
    };

    const server = buildGoogleServer({
      grants: ['calendar.read'],
      fetchImpl: api,
      tokens: new TokenCache({
        fetchImpl: tokenSource,
        clientId: 'c',
        clientSecret: 's',
        refreshToken: 'rt',
      }),
      version,
    });

    const result = await invokeTool(server, 'calendar_list_events', {
      timeMin: 'a',
      timeMax: 'b',
      calendarId: 'primary',
      limit: 10,
    });

    expect(apiCalls).toBe(2);
    // The retry must use a *new* token, or it is just the same failure twice.
    expect(minted).toBe(2);
    expect(result.isError).toBeFalsy();
  });

  it('hands a refusal back as a readable tool result, not a broken transport', async () => {
    // The model can act on "insufficient authentication scopes" — tell the
    // user what to re-grant. A thrown error just reads as a dead server.
    const api: FetchLike = async () => ({
      ok: false,
      status: 403,
      text: async () =>
        JSON.stringify({ error: { message: 'Request had insufficient authentication scopes.' } }),
    });
    const server = buildGoogleServer({
      grants: ['calendar.read'],
      fetchImpl: api,
      tokens: new TokenCache({
        fetchImpl: (async () => ({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ access_token: 'at', expires_in: 3600 }),
        })) as FetchLike,
        clientId: 'c',
        clientSecret: 's',
        refreshToken: 'rt',
      }),
      version,
    });

    const result = await invokeTool(server, 'calendar_list_events', {
      timeMin: 'a',
      timeMax: 'b',
      calendarId: 'primary',
      limit: 10,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/insufficient authentication scopes/);
  });

  it('keeps the protocol stream clean: nothing is written to stdout', () => {
    // A stray console.log corrupts JSON-RPC and the CLI reports the server as
    // broken with no clue why, so the module must not print on load.
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    buildGoogleServer({
      grants: ['gmail.read'],
      fetchImpl: (async () => ({ ok: true, status: 200, text: async () => '{}' })) as FetchLike,
      tokens: new TokenCache({
        fetchImpl: (async () => ({ ok: true, status: 200, text: async () => '{}' })) as FetchLike,
        clientId: 'c',
        clientSecret: 's',
        refreshToken: 'rt',
      }),
      version,
    });
    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
  });
});
