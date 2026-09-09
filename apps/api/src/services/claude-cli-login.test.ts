/**
 * Reading the CLI's own sign-in out of its credentials store.
 *
 * The file is Anthropic's, not ours, so the reader must treat every shape it
 * could take as survivable: absent, unreadable, malformed, logged out. The
 * one semantic that matters is `full` — whether the sign-in carries the
 * session-sync scopes a setup token never has — because that is the fact the
 * interface builds its whole explanation on.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readCliLogin, writeCliLogin, type CliLoginTokens } from './claude-cli-login.js';

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

/**
 * Writing the store — the other half of renewing a sign-in from the interface.
 *
 * What is written is never invented: it is exactly what Anthropic's token
 * endpoint just returned for an authorization the owner approved in their own
 * browser. The tests below are about the *file*, which belongs to the CLI:
 * nothing else in it may be disturbed, a half-written file must never be
 * observable, and a write that would downgrade the sign-in must not happen at
 * all.
 */
const GRANT: CliLoginTokens = {
  accessToken: 'sk-ant-oat01-fresh',
  refreshToken: 'sk-ant-ort01-fresh',
  expiresAt: 1_800_000_000_000,
  refreshTokenExpiresAt: 1_802_000_000_000,
  scopes: ['user:profile', 'user:inference', 'user:sessions:claude_code', 'user:mcp_servers'],
  subscriptionType: 'max',
  rateLimitTier: 'default_claude_max_20x',
  clientId: 'client-abc',
};

function readStore(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, '.credentials.json'), 'utf8')) as Record<string, unknown>;
}

describe('writeCliLogin', () => {
  it('writes a sign-in the reader then reports as full', () => {
    const dir = store(null);
    const written = writeCliLogin(dir, GRANT);

    expect(written).toEqual({
      full: true,
      scopes: GRANT.scopes,
      subscriptionType: 'max',
      expiresAt: 1_800_000_000_000,
      signInEndsAt: 1_802_000_000_000,
    });
    // The return value is the reader's verdict on the bytes, not a copy of
    // the argument: a write the reader cannot use is a failed renewal however
    // well it went on the wire.
    expect(readCliLogin(dir)).toEqual(written);
  });

  it('leaves everything else in the file alone', () => {
    // The file is the CLI's, and it carries more than the sign-in: the design
    // OAuth node, the account record, the trusted-device token. Rewriting the
    // file to hold only what this code understands would log the owner out of
    // things it has never heard of.
    const dir = store(
      JSON.stringify({
        claudeAiOauth: { ...FULL.claudeAiOauth },
        designOauth: { refreshToken: 'design-refresh' },
        organizationUuid: 'org-1',
        trustedDeviceToken: 'device-1',
      }),
    );
    writeCliLogin(dir, GRANT);

    const after = readStore(dir);
    expect(after.designOauth).toEqual({ refreshToken: 'design-refresh' });
    expect(after.organizationUuid).toBe('org-1');
    expect(after.trustedDeviceToken).toBe('device-1');
  });

  it('keeps what the grant does not carry, rather than blanking it', () => {
    // The CLI's own merge does this, measured in the shipped binary: a
    // subscription tier and a rate-limit tier survive a refresh that does not
    // restate them. A renewal that answered no plan would show an owner on Max
    // as being on nothing.
    const dir = store(
      JSON.stringify({
        claudeAiOauth: {
          ...FULL.claudeAiOauth,
          subscriptionType: 'max',
          rateLimitTier: 'default_claude_max_20x',
          refreshTokenExpiresAt: 1_777_000_000_000,
        },
      }),
    );
    writeCliLogin(dir, {
      ...GRANT,
      subscriptionType: null,
      rateLimitTier: null,
      refreshTokenExpiresAt: null,
    });

    const oauth = readStore(dir).claudeAiOauth as Record<string, unknown>;
    expect(oauth.subscriptionType).toBe('max');
    expect(oauth.rateLimitTier).toBe('default_claude_max_20x');
    expect(oauth.refreshTokenExpiresAt).toBe(1_777_000_000_000);
    // And the new grant's own values do land.
    expect(oauth.accessToken).toBe('sk-ant-oat01-fresh');
    expect(oauth.refreshToken).toBe('sk-ant-ort01-fresh');
  });

  it('refuses a grant that would downgrade the sign-in, and touches nothing', () => {
    // An inference-only grant is exactly what the paired token already is.
    // Writing it here would end the account sign-in — the session sync, the
    // MCP servers, the quota reporting — while the screen said "renewed".
    const dir = store(JSON.stringify(FULL));
    expect(() =>
      writeCliLogin(dir, { ...GRANT, scopes: ['user:inference'] }),
    ).toThrow(/session/i);

    const oauth = readStore(dir).claudeAiOauth as Record<string, unknown>;
    expect(oauth.accessToken).toBe(FULL.claudeAiOauth.accessToken);
  });

  it('renews over a malformed file rather than being trapped by it', () => {
    // The owner has just approved an authorization. Refusing because the
    // previous file is unreadable would leave them with no way through at all,
    // and there is nothing in an unparseable file worth preserving.
    const dir = store('{not json');
    expect(writeCliLogin(dir, GRANT).full).toBe(true);
  });

  it('creates the config directory when the CLI has never run here', () => {
    // Signing in for the first time on a fresh machine is exactly when
    // `~/.claude` does not exist, and an ENOENT there would refuse the one
    // case the flow was built for.
    const fresh = join(store(null), 'never-used');
    expect(writeCliLogin(fresh, GRANT).full).toBe(true);
    expect(readCliLogin(fresh)).not.toBeNull();
  });

  it('leaves no temporary file behind', () => {
    // The write is atomic — a rename over a unique temporary — so no reader
    // ever sees half a credentials file. What that must not do is litter the
    // CLI's own directory.
    const dir = store(null);
    writeCliLogin(dir, GRANT);
    expect(readdirSync(dir)).toEqual(['.credentials.json']);
  });

  it.runIf(process.platform !== 'win32')('writes it readable by nobody else', () => {
    const dir = store(null);
    writeCliLogin(dir, GRANT);
    expect(statSync(join(dir, '.credentials.json')).mode & 0o777).toBe(0o600);
  });
});
