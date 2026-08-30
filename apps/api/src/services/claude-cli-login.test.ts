/**
 * Reading the CLI's own sign-in out of its credentials store.
 *
 * The file is Anthropic's, not ours, so the reader must treat every shape it
 * could take as survivable: absent, unreadable, malformed, logged out. The
 * one semantic that matters is `full` — whether the sign-in carries the
 * session-sync scopes a setup token never has — because that is the fact the
 * interface builds its whole explanation on.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readCliLogin } from './claude-cli-login.js';

let dir: string;
const dirs: string[] = [];

function store(content: string | null): string {
  dir = mkdtempSync(join(tmpdir(), 'mc-cli-login-'));
  dirs.push(dir);
  if (content !== null) writeFileSync(join(dir, '.credentials.json'), content, 'utf8');
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const FULL = {
  claudeAiOauth: {
    accessToken: 'sk-ant-oat01-live',
    refreshToken: 'sk-ant-ort01-live',
    expiresAt: 1_900_000_000_000,
    scopes: ['user:profile', 'user:inference', 'user:sessions:claude_code', 'user:mcp_servers'],
    subscriptionType: 'max',
  },
};

describe('readCliLogin', () => {
  it('reads a full account sign-in, and says so', () => {
    const login = readCliLogin(store(JSON.stringify(FULL)));
    expect(login).toEqual({
      full: true,
      scopes: FULL.claudeAiOauth.scopes,
      subscriptionType: 'max',
      expiresAt: 1_900_000_000_000,
      signInEndsAt: null,
    });
  });

  it('classifies an inference-only sign-in as not full', () => {
    const login = readCliLogin(
      store(
        JSON.stringify({
          claudeAiOauth: {
            accessToken: 'sk-ant-oat01-x',
            refreshToken: 'sk-ant-ort01-x',
            scopes: ['user:inference'],
            subscriptionType: null,
          },
        }),
      ),
    );
    expect(login).toMatchObject({ full: false, scopes: ['user:inference'] });
    expect(login?.expiresAt).toBeNull();
  });

  it('treats an empty refresh token as logged out, the way the CLI does', () => {
    // The CLI marks logout by blanking the refresh token rather than deleting
    // the file; a reader that only checks presence would resurrect a sign-in
    // the owner explicitly ended.
    const loggedOut = {
      claudeAiOauth: { ...FULL.claudeAiOauth, refreshToken: '' },
    };
    expect(readCliLogin(store(JSON.stringify(loggedOut)))).toBeNull();
  });

  it('answers null for a store that never signed in', () => {
    expect(readCliLogin(store(null))).toBeNull();
    expect(readCliLogin('/nonexistent/claude-config')).toBeNull();
  });

  it('survives a malformed or half-shaped file', () => {
    expect(readCliLogin(store('{not json'))).toBeNull();
    expect(readCliLogin(store('{}'))).toBeNull();
    expect(readCliLogin(store(JSON.stringify({ claudeAiOauth: { scopes: 'oops' } })))).toBeNull();
    expect(
      readCliLogin(store(JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: 'r' } }))),
    ).toBeNull();
  });
});

/**
 * When the sign-in itself ends — which is not `expiresAt`.
 *
 * Measured on a live deployment: `expiresAt` is the *access* token's, about
 * eight hours out, and the CLI rotates it on its own. Two backups a day apart
 * showed it move from 06:02 to 07:07 the next day while
 * `refreshTokenExpiresAt` stayed at exactly the same instant — so the refresh
 * token is fixed-term, not rolling, and no amount of activity extends it.
 *
 * That makes it the only date worth watching: when it passes, every run fails
 * to authenticate at once, and nothing else in the product knows it is coming.
 */
describe('the end of the sign-in', () => {
  it('reads the refresh token’s expiry, which is the one that matters', () => {
    const login = readCliLogin(
      store(
        JSON.stringify({
          claudeAiOauth: {
            ...FULL.claudeAiOauth,
            expiresAt: 1_788_000_000_000,
            refreshTokenExpiresAt: 1_790_000_000_000,
          },
        }),
      ),
    );
    expect(login?.expiresAt).toBe(1_788_000_000_000);
    expect(login?.signInEndsAt).toBe(1_790_000_000_000);
  });

  it('answers null when the store does not carry one', () => {
    // A setup token's store has no such field, and an older CLI may not write
    // it. Absent is "unknown", never "expired".
    expect(readCliLogin(store(JSON.stringify(FULL)))?.signInEndsAt).toBeNull();
  });

  it('ignores a value that is not a number', () => {
    const login = readCliLogin(
      store(
        JSON.stringify({
          claudeAiOauth: { ...FULL.claudeAiOauth, refreshTokenExpiresAt: 'soon' },
        }),
      ),
    );
    expect(login?.signInEndsAt).toBeNull();
  });
});
