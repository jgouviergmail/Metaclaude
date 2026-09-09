/**
 * The credential is the one setting without which nothing in the product
 * works, and it is now settable from a phone. These tests are about the two
 * ways that goes wrong quietly: the wrong credential being used, and both being
 * used at once.
 */

import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type Db } from '../db/index.js';
import { Vault } from '../security/vault.js';
import { ClaudeCredentials, CredentialError } from './claude-credentials.js';

const TOKEN = 'sk-ant-oat01-paired-from-the-interface-AAAA';
const OTHER_TOKEN = 'sk-ant-oat01-a-second-one-entirely-BBBB';
const API_KEY = 'sk-ant-api03-pay-as-you-go-CCCC';

let db: Db;
let vault: Vault;

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  migrate(db);
  vault = new Vault(db, randomBytes(32));
});

/** Build a service over a fresh environment object, as the context does. */
function build(fromEnvironment: { oauthToken: string | null; apiKey: string | null }) {
  const env: Record<string, string> = {};
  const credentials = new ClaudeCredentials({ vault, env, fromEnvironment });
  return { env, credentials };
}

const NOTHING = { oauthToken: null, apiKey: null };

/**
 * When the credential in force stops working.
 *
 * The screen had one date and it was the *sign-in's*, read off the CLI store
 * whether or not that sign-in was the credential being used. So an owner who
 * paired a token saw a countdown belonging to a credential the pairing had
 * just shadowed — and the token they were actually running on, which expires
 * in a year, was tracked by nothing at all. The date has to follow the
 * credential in force or it is worse than absent: it is a reassurance about
 * the wrong thing.
 */
describe('when the credential in force runs out', () => {
  const CLI_LOGIN = {
    full: true,
    scopes: ['user:inference', 'user:sessions:claude_code'],
    subscriptionType: 'max',
    expiresAt: 1_700_000_000_000,
    signInEndsAt: 1_800_000_000_000,
  };

  it('is the sign-in’s end when the sign-in is what applies', () => {
    const env: Record<string, string> = {};
    const credentials = new ClaudeCredentials({
      vault,
      env,
      fromEnvironment: NOTHING,
      cliLogin: () => CLI_LOGIN,
    });

    expect(credentials.status()).toMatchObject({ source: 'cli-login', expiresAt: 1_800_000_000_000 });
  });

  it('is the paired token’s own end once a pairing shadows that sign-in', () => {
    const env: Record<string, string> = {};
    const credentials = new ClaudeCredentials({
      vault,
      env,
      fromEnvironment: NOTHING,
      cliLogin: () => CLI_LOGIN,
    });

    credentials.save(TOKEN, { expiresAt: 1_900_000_000_000 });

    // The sign-in's date is still reported, because the card offers to hand
    // back to it — but it is no longer the answer to "when does this stop".
    expect(credentials.status()).toMatchObject({
      source: 'stored',
      expiresAt: 1_900_000_000_000,
      cliLogin: { signInEndsAt: 1_800_000_000_000 },
    });
  });

  /**
   * A token pasted by hand carries no expiry anybody here can read, and the
   * previous pairing's date must not be attributed to it: a stale date on a
   * new credential is the reassurance-about-the-wrong-thing defect again, one
   * turn further on.
   */
  it('forgets the date when a token arrives without one', () => {
    const { credentials } = build(NOTHING);
    credentials.save(TOKEN, { expiresAt: 1_900_000_000_000 });

    credentials.save(OTHER_TOKEN);

    expect(credentials.status()).toMatchObject({ source: 'stored', expiresAt: null });
  });

  it('has no date for an API key, which does not expire', () => {
    const { credentials } = build(NOTHING);
    credentials.save(API_KEY);
    expect(credentials.status()).toMatchObject({ mode: 'api_key', expiresAt: null });
  });

  it('has no date for a token from the environment, minted somewhere else', () => {
    // A fresh vault: `build` shares the one the suite opens, so a credential
    // stored by a neighbouring case would still be winning here.
    const { credentials } = build({ oauthToken: TOKEN, apiKey: null });
    expect(credentials.status()).toMatchObject({ source: 'environment', expiresAt: null });
  });

  it('survives a restart, like the token it belongs to', () => {
    const { credentials } = build(NOTHING);
    credentials.save(TOKEN, { expiresAt: 1_900_000_000_000 });

    const { credentials: reopened } = build(NOTHING);
    expect(reopened.status()).toMatchObject({ expiresAt: 1_900_000_000_000 });
  });
});

describe('where the credential comes from', () => {
  it('uses the environment when nothing has been paired', () => {
    const { env, credentials } = build({ oauthToken: TOKEN, apiKey: null });
    expect(credentials.status()).toEqual({ mode: 'subscription', source: 'environment', hint: '…AAAA', cliLogin: null, expiresAt: null });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
  });

  it('prefers a paired credential over the environment', () => {
    const { env, credentials } = build({ oauthToken: TOKEN, apiKey: null });
    credentials.save(OTHER_TOKEN);
    expect(credentials.status()).toEqual({ mode: 'subscription', source: 'stored', hint: '…BBBB', cliLogin: null, expiresAt: null });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(OTHER_TOKEN);
  });

  it('falls back to the environment when the paired credential is removed', () => {
    const { env, credentials } = build({ oauthToken: TOKEN, apiKey: null });
    credentials.save(OTHER_TOKEN);
    credentials.clear();
    expect(credentials.status().source).toBe('environment');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
  });

  it('reports none when there is nothing anywhere', () => {
    const { env, credentials } = build(NOTHING);
    expect(credentials.status()).toEqual({ mode: 'none', source: null, hint: null, cliLogin: null, expiresAt: null });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('survives a restart — a new service over the same vault finds the pairing', () => {
    const first = build(NOTHING);
    first.credentials.save(TOKEN);

    const second = build(NOTHING);
    expect(second.credentials.status()).toEqual({ mode: 'subscription', source: 'stored', hint: '…AAAA', cliLogin: null, expiresAt: null });
    expect(second.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
  });
});

describe('never two credentials at once', () => {
  // Both work, so a leftover API key next to a subscription token bills the
  // owner per request while the subscription they pay for goes unused — and
  // nothing anywhere reports it.
  it('pairing a subscription clears a stored API key', () => {
    const { env, credentials } = build(NOTHING);
    credentials.save(API_KEY);
    expect(env.ANTHROPIC_API_KEY).toBe(API_KEY);

    credentials.save(TOKEN);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(credentials.status().mode).toBe('subscription');
  });

  it('pairing an API key clears a stored subscription token', () => {
    const { env, credentials } = build(NOTHING);
    credentials.save(TOKEN);
    credentials.save(API_KEY);
    expect(env.ANTHROPIC_API_KEY).toBe(API_KEY);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it('a stored subscription shadows an API key in the environment', () => {
    const { env, credentials } = build({ oauthToken: null, apiKey: API_KEY });
    expect(env.ANTHROPIC_API_KEY).toBe(API_KEY);

    credentials.save(TOKEN);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

describe('what it accepts', () => {
  it('classifies by prefix, so the owner never has to', () => {
    const { credentials } = build(NOTHING);
    expect(credentials.save(TOKEN).mode).toBe('subscription');
    expect(credentials.save(API_KEY).mode).toBe('api_key');
  });

  it('tolerates the whitespace a paste brings with it', () => {
    const { env, credentials } = build(NOTHING);
    credentials.save(`  ${TOKEN}\n`);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
  });

  it('refuses something that is not a credential, and says what one looks like', () => {
    const { credentials } = build(NOTHING);
    expect(() => credentials.save('hunter2')).toThrow(CredentialError);
    expect(() => credentials.save('hunter2')).toThrow(/sk-ant-oat/);
  });

  it('refuses an empty paste', () => {
    const { credentials } = build(NOTHING);
    expect(() => credentials.save('   ')).toThrow(CredentialError);
  });

  it('leaves the previous credential in place when a bad one is rejected', () => {
    const { env, credentials } = build(NOTHING);
    credentials.save(TOKEN);
    expect(() => credentials.save('nonsense')).toThrow();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
  });
});

describe('the credential does not leak', () => {
  it('status carries only the last four characters', () => {
    const { credentials } = build(NOTHING);
    const status = credentials.save(TOKEN);
    expect(JSON.stringify(status)).not.toContain(TOKEN);
    expect(status.hint).toBe('…AAAA');
  });

  it('is stored encrypted, not as plaintext in the database', () => {
    const { credentials } = build(NOTHING);
    credentials.save(TOKEN);
    const rows = db.prepare("SELECT * FROM secrets").all() as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
    // And it really is recoverable — an unreadable secret would pass the check
    // above for the wrong reason.
    expect(vault.get('global', 'claude.oauth_token')).toBe(TOKEN);
  });
});

describe('the CLI’s own sign-in', () => {
  const LOGIN = {
    full: true,
    scopes: ['user:profile', 'user:inference', 'user:sessions:claude_code'],
    subscriptionType: 'max' as string | null,
    expiresAt: 1_900_000_000_000 as number | null,
    signInEndsAt: 1_990_000_000_000 as number | null,
  };

  /** Like build(), plus a CLI store holding a sign-in. */
  function buildWithLogin(fromEnvironment: { oauthToken: string | null; apiKey: string | null }) {
    const env: Record<string, string> = {};
    const credentials = new ClaudeCredentials({
      vault,
      env,
      fromEnvironment,
      cliLogin: () => LOGIN,
    });
    return { env, credentials };
  }

  it('is the fallback when nothing is injected — and injects nothing itself', () => {
    // The CLI reads its own store exactly when no token variable is set; an
    // injected token would override the sign-in. Empty env IS the handover.
    const { env, credentials } = buildWithLogin(NOTHING);
    expect(credentials.status()).toEqual({
      mode: 'subscription',
      source: 'cli-login',
      hint: null,
      cliLogin: LOGIN,
      // The sign-in is the credential here, so its end is the date to watch.
      expiresAt: LOGIN.signInEndsAt,
    });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('is shadowed by any injected token, and the status says both halves', () => {
    const { env, credentials } = buildWithLogin({ oauthToken: TOKEN, apiKey: null });
    const status = credentials.status();
    expect(status.source).toBe('environment');
    expect(status.cliLogin).toEqual(LOGIN);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
  });

  it('takes over when the shadowing credential is removed', () => {
    const { env, credentials } = buildWithLogin(NOTHING);
    credentials.save(TOKEN);
    expect(credentials.status().source).toBe('stored');

    credentials.clear();
    expect(credentials.status().source).toBe('cli-login');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
});
