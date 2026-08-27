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
import { migrate, openDatabase, type Db } from '../db/index.js';
import { Vault } from '../security/vault.js';
import { ClaudeCredentials } from './claude-credentials.js';
import { ClaudePairing, PairingError, type PairingExchange } from './claude-pairing.js';

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
    expect(pairing.status()).toEqual({ active: false, expiresAt: null });

    const start = pairing.begin('claudeai');
    expect(start.expiresAt).toBe(1_000_000 + 10 * 60_000);
    expect(pairing.status()).toEqual({ active: true, expiresAt: start.expiresAt });

    pairing.cancel();
    expect(pairing.status()).toEqual({ active: false, expiresAt: null });
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
  it('exchanges the pasted code with the verifier that produced the challenge', async () => {
    const { pairing, calls } = build();
    const start = pairing.begin('claudeai');
    const url = new URL(start.url);

    const status = await pairing.complete(`the-code#${url.searchParams.get('state')}`);

    expect(status).toEqual({ mode: 'subscription', source: 'stored', hint: '…DDDD' });
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
