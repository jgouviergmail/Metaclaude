/**
 * Losing the race with the CLI, and saying so.
 *
 * The credentials store belongs to the CLI, which rewrites it whenever it
 * refreshes — and it may be doing that inside a run happening right now. A
 * rename cannot be interleaved, so the file is never half-written; what can
 * happen is the *other order*, the CLI's rename landing after ours, leaving
 * the store holding the sign-in from before the renewal. Nothing about the
 * write would fail, and a read-back that only asked "is this signed in?" would
 * answer yes about the wrong sign-in.
 *
 * There is no lock to take: the CLI's protocol is its own. So the check is a
 * comparison, and the honest outcome is a message rather than a false success.
 *
 * `node:fs` is mocked in a file of its own because the mock is hoisted above
 * every import: sharing it with the reader's tests would put every one of them
 * behind an interception they have no use for.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  /** What a rival writer puts in the file the instant after our rename. */
  overwriteWith: null as string | null,
}));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    renameSync: (from: string, to: string) => {
      real.renameSync(from, to);
      // The CLI's own write, landing one instant later.
      if (state.overwriteWith !== null) real.writeFileSync(to, state.overwriteWith, 'utf8');
    },
  };
});

const { writeCliLogin, CliLoginWriteError } = await import('./claude-cli-login.js');
type Tokens = Parameters<typeof writeCliLogin>[1];

const GRANT: Tokens = {
  accessToken: 'sk-ant-oat01-ours',
  refreshToken: 'sk-ant-ort01-ours',
  expiresAt: 1_800_000_000_000,
  refreshTokenExpiresAt: 1_802_000_000_000,
  scopes: ['user:profile', 'user:inference', 'user:sessions:claude_code', 'user:mcp_servers'],
  subscriptionType: 'max',
  rateLimitTier: 'default_claude_max_20x',
  clientId: 'client-abc',
};

const dirs: string[] = [];
function store(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mc-cli-race-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  state.overwriteWith = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('a concurrent write by the CLI', () => {
  it('is reported rather than reported as success', () => {
    const dir = store();
    // A complete, valid sign-in — just not the one that was installed.
    state.overwriteWith = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-theirs',
        refreshToken: 'sk-ant-ort01-theirs',
        expiresAt: 1_700_000_000_000,
        scopes: GRANT.scopes,
        subscriptionType: 'max',
      },
    });

    expect(() => writeCliLogin(dir, GRANT)).toThrow(CliLoginWriteError);
    expect(() => writeCliLogin(dir, GRANT)).toThrow(/same moment/i);
  });

  it('succeeds when nothing else writes', () => {
    // The other half of the claim: the check must not refuse the ordinary
    // case, or the button would fail every time on a quiet machine.
    const dir = store();
    expect(writeCliLogin(dir, GRANT).full).toBe(true);
    const stored = JSON.parse(readFileSync(join(dir, '.credentials.json'), 'utf8')) as {
      claudeAiOauth: { accessToken: string };
    };
    expect(stored.claudeAiOauth.accessToken).toBe('sk-ant-oat01-ours');
  });

  it('is not confused by an unrelated file in the directory', () => {
    const dir = store();
    writeFileSync(join(dir, 'settings.json'), '{}', 'utf8');
    expect(writeCliLogin(dir, GRANT).full).toBe(true);
  });
});
