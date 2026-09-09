/**
 * The guided pairing flow, which replicates `claude setup-token` server-side.
 *
 * Two properties carry the whole feature. The PKCE material must genuinely
 * bind the link to the exchange — a challenge that does not hash the verifier
 * is a flow any interceptor can finish. And every failure must leave the
 * owner somewhere sensible: a mistyped code retriable, an expired attempt
 * restartable, and a code from an older tab told apart from a bad one.
 */

import { createHash, randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeCliLoginInfo } from '@metaclaude/shared';
import { migrate, openDatabase, type Db } from '../db/index.js';
import { Vault } from '../security/vault.js';
import { CliLoginWriteError, type CliLoginTokens } from './claude-cli-login.js';
import { ClaudeCredentials } from './claude-credentials.js';
import {
  ClaudePairing,
  PairingError,
  type AccountProfile,
  type PairingExchange,
} from './claude-pairing.js';

const TOKEN = 'sk-ant-oat01-freshly-minted-by-the-exchange-DDDD';

let db: Db;
let vault: Vault;
let credentials: ClaudeCredentials;
let env: Record<string, string>;

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  migrate(db);
  vault = new Vault(db, randomBytes(32));
  env = {};
  credentials = new ClaudeCredentials({
    vault,
    env,
    fromEnvironment: { oauthToken: null, apiKey: null },
  });
});

/** A pairing service over a scripted token endpoint. */
function build(options: { answer?: PairingExchange; now?: () => number } = {}) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const pairing = new ClaudePairing({
    credentials,
    post: async (url, body) => {
      calls.push({ url, body });
      return (
        options.answer ?? {
          status: 200,
          statusText: 'OK',
          body: { access_token: TOKEN, expires_in: 31536000 },
        }
      );
    },
    now: options.now,
  });
  return { pairing, calls };
}

const base64url = /^[A-Za-z0-9_-]+$/;

describe('beginning a pairing attempt', () => {
  it('builds the claude.ai authorization link the way the CLI does', () => {
    const { pairing } = build();
    const start = pairing.begin('claudeai');

    const url = new URL(start.url);
    expect(url.origin + url.pathname).toBe('https://claude.com/cai/oauth/authorize');
    // `code=true` is what makes the callback page display the code to copy
    // instead of expecting a localhost listener this server cannot be.
    expect(url.searchParams.get('code')).toBe('true');
    expect(url.searchParams.get('client_id')).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://platform.claude.com/oauth/code/callback',
    );
    expect(url.searchParams.get('scope')).toBe('user:inference');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(base64url);
    expect(url.searchParams.get('state')).toMatch(base64url);
  });

  it('sends a Console account to the platform sign-in instead', () => {
    const { pairing } = build();
    const url = new URL(pairing.begin('console').url);
    expect(url.origin + url.pathname).toBe('https://platform.claude.com/oauth/authorize');
  });

  it('reports the attempt while it lives, and its expiry', () => {
    const { pairing } = build({ now: () => 1_000_000 });
    expect(pairing.status()).toEqual({ active: false, expiresAt: null, kind: null });

    const start = pairing.begin('claudeai');
    expect(start.expiresAt).toBe(1_000_000 + 10 * 60_000);
    expect(pairing.status()).toEqual({ active: true, expiresAt: start.expiresAt, kind: 'token' });

    pairing.cancel();
    expect(pairing.status()).toEqual({ active: false, expiresAt: null, kind: null });
  });

  it('replaces the previous attempt: only the newest state is on the link', () => {
    const { pairing } = build();
    const first = new URL(pairing.begin('claudeai').url).searchParams.get('state');
    const second = new URL(pairing.begin('claudeai').url).searchParams.get('state');
    expect(second).not.toBe(first);
    expect(pairing.status().active).toBe(true);
  });
});

describe('completing the exchange', () => {
  /**
   * The date comes back with the token, and it is the one thing about a paired
   * token nobody could see before.
   *
   * It is read off the *answer* rather than the request: `expires_in` is what
   * Anthropic granted, `TOKEN_TTL_SECONDS` is what was asked for, and putting
   * the ask on the screen would be a countdown the credential does not honour.
   */
  it('records when the token Anthropic granted actually runs out', async () => {
    const { pairing } = build({
      now: () => 1_000_000,
      answer: {
        status: 200,
        statusText: 'OK',
        // Not the year that was asked for: a grant is the grantor's to shorten.
        body: { access_token: TOKEN, expires_in: 3600 },
      },
    });
    const start = pairing.begin('claudeai');

    const status = await pairing.complete(
      `the-code#${new URL(start.url).searchParams.get('state')}`,
    );

    expect(status.expiresAt).toBe(1_000_000 + 3600 * 1000);
  });

  it('falls back to the lifetime it asked for when the answer is silent', async () => {
    const { pairing } = build({
      now: () => 1_000_000,
      answer: { status: 200, statusText: 'OK', body: { access_token: TOKEN } },
    });
    const start = pairing.begin('claudeai');

    const status = await pairing.complete(
      `the-code#${new URL(start.url).searchParams.get('state')}`,
    );

    // A year, the `setup-token` default — better than null, which the screen
    // would read as "nothing to watch" for a credential that does expire.
    expect(status.expiresAt).toBe(1_000_000 + 31_536_000 * 1000);
  });

  it('exchanges the pasted code with the verifier that produced the challenge', async () => {
    const { pairing, calls } = build();
    const start = pairing.begin('claudeai');
    const url = new URL(start.url);

    const status = await pairing.complete(`the-code#${url.searchParams.get('state')}`);

    expect(status).toMatchObject({ mode: 'subscription', source: 'stored', hint: '…DDDD', cliLogin: null });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://platform.claude.com/v1/oauth/token');
    const body = calls[0]?.body as Record<string, string | number>;
    expect(body.grant_type).toBe('authorization_code');
    expect(body.code).toBe('the-code');
    expect(body.state).toBe(url.searchParams.get('state'));
    expect(body.redirect_uri).toBe('https://platform.claude.com/oauth/code/callback');
    expect(body.client_id).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e');
    // Long-lived, the way `claude setup-token` asks for it — a year, so the
    // pairing survives the phone that performed it.
    expect(body.expires_in).toBe(31536000);

    // The PKCE binding, verified rather than assumed: the verifier sent to
    // the token endpoint must hash to the challenge that was on the link.
    const challenge = createHash('sha256')
      .update(String(body.code_verifier))
      .digest('base64url');
    expect(challenge).toBe(url.searchParams.get('code_challenge'));

    // Consumed: the same code cannot be exchanged twice from this server.
    expect(pairing.status().active).toBe(false);
  });

  it('accepts a bare code, supplying the stored state itself', async () => {
    const { pairing, calls } = build();
    const start = pairing.begin('claudeai');
    await pairing.complete('  bare-code  ');
    const body = calls[0]?.body as Record<string, string>;
    expect(body.code).toBe('bare-code');
    expect(body.state).toBe(new URL(start.url).searchParams.get('state'));
  });

  it('refuses before anything was begun', async () => {
    const { pairing, calls } = build();
    await expect(pairing.complete('code#state')).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(calls).toHaveLength(0);
  });

  it('refuses a code pasted after the attempt expired, and clears the attempt', async () => {
    let at = 1_000_000;
    const { pairing, calls } = build({ now: () => at });
    pairing.begin('claudeai');
    at += 10 * 60_000 + 1;
    await expect(pairing.complete('code')).rejects.toThrow(/expired/i);
    expect(pairing.status().active).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('tells a code from another attempt apart from a bad one', async () => {
    const { pairing, calls } = build();
    pairing.begin('claudeai');
    await expect(pairing.complete('code#some-older-state')).rejects.toThrow(/newest link/i);
    // Not sent: the exchange would fail anyway, and the message would then
    // read as "bad code" when the fix is "use the newer tab".
    expect(calls).toHaveLength(0);
    expect(pairing.status().active).toBe(true);
  });

  it('keeps the attempt alive when Claude rejects the code, so a re-paste can work', async () => {
    const { pairing } = build({
      answer: { status: 401, statusText: 'Unauthorized', body: {} },
    });
    pairing.begin('claudeai');
    await expect(pairing.complete('mistyped')).rejects.toThrow(/did not accept/i);
    expect(pairing.status().active).toBe(true);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it('never surfaces a 401 of its own — the web client reads that as logged out', async () => {
    const { pairing } = build({
      answer: { status: 401, statusText: 'Unauthorized', body: {} },
    });
    pairing.begin('claudeai');
    const failure = await pairing.complete('mistyped').catch((error: PairingError) => error);
    expect(failure).toBeInstanceOf(PairingError);
    expect((failure as PairingError).statusCode).toBe(400);
  });

  it('reports an exchange the service itself broke on, with the status', async () => {
    const { pairing } = build({
      answer: { status: 500, statusText: 'Internal Server Error', body: {} },
    });
    pairing.begin('claudeai');
    await expect(pairing.complete('code')).rejects.toThrow(/500/);
  });

  it('reports an unreachable token service as the network problem it is', async () => {
    const pairing = new ClaudePairing({
      credentials,
      post: async () => {
        throw new Error('getaddrinfo ENOTFOUND platform.claude.com');
      },
    });
    pairing.begin('claudeai');
    await expect(pairing.complete('code')).rejects.toThrow(/ENOTFOUND/);
    expect(pairing.status().active).toBe(true);
  });

  it('refuses an answer without a token in it', async () => {
    const { pairing } = build({ answer: { status: 200, statusText: 'OK', body: {} } });
    pairing.begin('claudeai');
    await expect(pairing.complete('code')).rejects.toThrow(/without a token/i);
  });

  it('lets the credential service refuse a token of an unknown shape', async () => {
    const { pairing } = build({
      answer: { status: 200, statusText: 'OK', body: { access_token: 'not-a-claude-token' } },
    });
    pairing.begin('claudeai');
    await expect(pairing.complete('code')).rejects.toThrow(/does not look like/i);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it('refuses an empty paste before reaching for the network', async () => {
    const { pairing, calls } = build();
    pairing.begin('claudeai');
    await expect(pairing.complete('   ')).rejects.toThrow(/paste/i);
    expect(calls).toHaveLength(0);
  });
});

describe('the real token endpoint call', () => {
  it('posts JSON and parses the answer', async () => {
    // The default `post` is exercised against a local listener so the wire
    // format (JSON in, JSON out) is proven without touching Anthropic.
    const { createServer } = await import('node:http');
    const received: Array<{ contentType: string | undefined; body: string }> = [];
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString()));
      request.on('end', () => {
        received.push({ contentType: request.headers['content-type'], body });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ access_token: TOKEN }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const pairing = new ClaudePairing({
        credentials,
        tokenUrl: `http://127.0.0.1:${port}/v1/oauth/token`,
      });
      pairing.begin('claudeai');
      const status = await pairing.complete('code');
      expect(status.mode).toBe('subscription');
      expect(received[0]?.contentType).toBe('application/json');
      expect(JSON.parse(received[0]?.body ?? '{}').grant_type).toBe('authorization_code');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

/**
 * Renewing the account sign-in — the same flow, a different destination.
 *
 * A paired token and an account sign-in are two credentials with two
 * lifetimes, two scope sets and two homes: the vault for one, the CLI's own
 * store for the other. Everything between the link and the pasted code is
 * shared; what must not be shared is where the answer lands, because putting
 * an account grant in the vault would shadow the very sign-in it renewed, and
 * putting an inference token in the CLI's store would end it.
 */
const ACCOUNT_ANSWER: PairingExchange = {
  status: 200,
  statusText: 'OK',
  get body() {
    return ACCOUNT_GRANT;
  },
};

const ACCOUNT_GRANT = {
  access_token: 'sk-ant-oat01-account-grant',
  refresh_token: 'sk-ant-ort01-account-grant',
  expires_in: 28_800,
  refresh_token_expires_in: 2_592_000,
  scope: 'user:profile user:inference user:sessions:claude_code user:mcp_servers',
};

/** A pairing service whose account grants land in a recording store. */
function buildAccount(
  options: {
    answer?: PairingExchange;
    profile?: (token: string) => Promise<AccountProfile | null>;
    install?: (tokens: CliLoginTokens) => ClaudeCliLoginInfo;
  } = {},
) {
  const installed: CliLoginTokens[] = [];
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  // The store the install writes to, read back by the credential service the
  // way the real one reads `.credentials.json` — so the status this flow
  // returns is derived from what was installed, never asserted about it.
  let signIn: ClaudeCliLoginInfo | null = null;
  const pairing = new ClaudePairing({
    credentials: new ClaudeCredentials({
      vault,
      env,
      fromEnvironment: { oauthToken: null, apiKey: null },
      cliLogin: () => signIn,
    }),
    post: async (url, body) => {
      calls.push({ url, body });
      return options.answer ?? { status: 200, statusText: 'OK', body: ACCOUNT_GRANT };
    },
    installSignIn: (tokens) => {
      installed.push(tokens);
      if (options.install) return options.install(tokens);
      signIn = {
        full: true,
        scopes: tokens.scopes,
        subscriptionType: tokens.subscriptionType,
        expiresAt: tokens.expiresAt,
        signInEndsAt: tokens.refreshTokenExpiresAt,
      };
      return signIn;
    },
    profile: options.profile,
    now: () => 1_000_000,
  });
  return { pairing, installed, calls };
}

describe('renewing the account sign-in', () => {
  it('asks for the scopes the CLI’s own sign-in asks for', () => {
    const { pairing } = buildAccount();
    const url = new URL(pairing.begin('claudeai', 'account').url);
    // Read out of the shipped CLI binary, in its order. Asking for less is an
    // untested subset; asking for more is a consent screen nobody agreed to.
    expect(url.searchParams.get('scope')).toBe(
      'org:create_api_key user:profile user:inference user:sessions:claude_code ' +
        'user:mcp_servers user:file_upload',
    );
    // Everything else about the link is the same flow.
    expect(url.searchParams.get('code')).toBe('true');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('still asks for inference alone when pairing a token', () => {
    const { pairing } = buildAccount();
    expect(new URL(pairing.begin('claudeai').url).searchParams.get('scope')).toBe('user:inference');
  });

  it('says which kind of attempt is open', () => {
    const { pairing } = buildAccount();
    expect(pairing.status().kind).toBeNull();
    pairing.begin('claudeai', 'account');
    // A reloaded page asks the server rather than remembering: finishing an
    // account attempt as a token one would seal a full-scope grant in the
    // vault, where it would shadow the sign-in it was meant to renew.
    expect(pairing.status().kind).toBe('account');
  });

  it('installs the grant in the CLI store and leaves the vault alone', async () => {
    const { pairing, installed } = buildAccount();
    pairing.begin('claudeai', 'account');
    const status = await pairing.complete('code');

    expect(installed).toHaveLength(1);
    expect(installed[0]).toMatchObject({
      accessToken: ACCOUNT_GRANT.access_token,
      refreshToken: ACCOUNT_GRANT.refresh_token,
      expiresAt: 1_000_000 + 28_800 * 1000,
      refreshTokenExpiresAt: 1_000_000 + 2_592_000 * 1000,
      scopes: ACCOUNT_GRANT.scope.split(' '),
      clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    });
    // Nothing was sealed: the account sign-in is not a Metaclaude secret, and
    // a stored token would override it on the very next run.
    expect(vault.get('global', 'claude.oauth_token')).toBeNull();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(status.source).toBe('cli-login');
  });

  it('does not ask for a year, the way a setup token does', async () => {
    const { pairing, calls } = buildAccount();
    pairing.begin('claudeai', 'account');
    await pairing.complete('code');
    // Measured in the CLI: `expires_in` rides the exchange only for
    // `setup-token`. A sign-in's access token is hours long and refreshed;
    // asking for a year would be asking for a different credential.
    expect(calls[0]?.body).not.toHaveProperty('expires_in');
    expect(calls[0]?.body.grant_type).toBe('authorization_code');
  });

  it('refuses a grant that came back without the session scope', async () => {
    const { pairing, installed } = buildAccount({
      answer: {
        status: 200,
        statusText: 'OK',
        body: { ...ACCOUNT_GRANT, scope: 'user:profile user:inference' },
      },
    });
    pairing.begin('claudeai', 'account');
    await expect(pairing.complete('code')).rejects.toThrow(PairingError);
    // Nothing installed: a downgrade written here would end the sign-in.
    expect(installed).toHaveLength(0);
  });

  it('refuses a grant with no refresh token, which is a sign-in that cannot last', async () => {
    const { pairing, installed } = buildAccount({
      answer: {
        status: 200,
        statusText: 'OK',
        body: { ...ACCOUNT_GRANT, refresh_token: undefined },
      },
    });
    pairing.begin('claudeai', 'account');
    await expect(pairing.complete('code')).rejects.toThrow(/refresh/i);
    expect(installed).toHaveLength(0);
  });

  it('fills the plan from the profile call when it answers', async () => {
    const { pairing, installed } = buildAccount({
      profile: async () => ({ subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' }),
    });
    pairing.begin('claudeai', 'account');
    await pairing.complete('code');
    expect(installed[0]?.subscriptionType).toBe('max');
  });

  it('renews anyway when the profile call fails', async () => {
    // Best-effort by design: the plan label is decoration, and a renewal that
    // failed on it would leave the owner with an approved authorization and
    // no sign-in. Null then means "keep what the store already had".
    const { pairing, installed } = buildAccount({
      profile: async () => {
        throw new Error('network down');
      },
    });
    pairing.begin('claudeai', 'account');
    const status = await pairing.complete('code');
    expect(installed[0]?.subscriptionType).toBeNull();
    expect(status.source).toBe('cli-login');
  });

  it('ends the attempt when the store cannot be written, because the code is spent', async () => {
    // The exchange succeeded, so Anthropic has consumed that code: re-pasting
    // it could only ever fail. The writer's message survives — it is the
    // useful one — and the status becomes the 409 the web client folds the
    // wizard on, rather than leaving an owner retyping something dead.
    const { pairing } = buildAccount({
      install: () => {
        throw new CliLoginWriteError('read-only file system');
      },
    });
    pairing.begin('claudeai', 'account');
    await expect(pairing.complete('code')).rejects.toThrow(/read-only file system/);
    expect(pairing.status()).toEqual({ active: false, expiresAt: null, kind: null });
  });

  it('refuses to open a wizard it could not finish', () => {
    // Finding out after the owner has approved an authorization costs them a
    // spent code for nothing.
    const pairing = new ClaudePairing({ credentials, post: async () => ACCOUNT_ANSWER });
    expect(() => pairing.begin('claudeai', 'account')).toThrow(PairingError);
    // The token flow needs no writer and is unaffected.
    expect(pairing.begin('claudeai').kind).toBe('token');
  });
});

describe('nothing secret leaks', () => {
  it('logs neither verifier, state nor token', async () => {
    const log = vi.fn<(level: 'info' | 'warn', message: string) => void>();
    const pairing = new ClaudePairing({
      credentials,
      post: async () => ({ status: 200, statusText: 'OK', body: { access_token: TOKEN } }),
      log,
    });
    const start = pairing.begin('claudeai');
    const state = new URL(start.url).searchParams.get('state') ?? 'unfindable';
    await pairing.complete(`code#${state}`);

    for (const [, message] of log.mock.calls) {
      expect(message).not.toContain(TOKEN);
      expect(message).not.toContain(state);
    }
  });
});
