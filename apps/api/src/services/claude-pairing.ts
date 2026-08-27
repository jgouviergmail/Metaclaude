/**
 * Guided pairing — the `claude setup-token` flow, run by the server.
 *
 * The manual path (run the CLI somewhere, paste what it prints) survives as
 * the fallback, but it assumes a shell, and this deployment is operated from
 * a phone. What `setup-token` actually does is a standard OAuth
 * authorization-code exchange with PKCE against Anthropic's public client:
 * build an authorization URL, have the owner approve it in a browser, take
 * the code the callback page displays, and trade it for a long-lived
 * `sk-ant-oat` token. Every step of that can be done here, with the browser
 * being the owner's own — which is the one thing they are guaranteed to have.
 *
 * The constants below are Anthropic's, read out of the very CLI binary this
 * image ships (the SDK vendors it), not guessed: the client id, both
 * authorize surfaces, the manual-redirect page that displays `code#state`,
 * the JSON token endpoint, and the one-year `expires_in` that makes the
 * token long-lived. They are Anthropic's to change; if they do, the exchange
 * fails loudly with the status it got, and the manual path still works.
 *
 * Security shape: the verifier and state never leave this process — the link
 * carries only the S256 challenge, so a leaked link is unfinishable without
 * the verifier, and a pasted code is bound to the attempt that minted it.
 * The token itself goes straight into the credential service (vault +
 * supervisor environment) and is never returned to the browser.
 */

import { createHash, randomBytes } from 'node:crypto';
import type {
  ClaudeCredentialStatus,
  ClaudePairingStart,
  ClaudePairingState,
} from '@metaclaude/shared';

/** Anthropic's public OAuth client for Claude Code, as shipped in the CLI. */
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLAUDE_AI_AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize';
const CONSOLE_AUTHORIZE_URL = 'https://platform.claude.com/oauth/authorize';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const MANUAL_REDIRECT_URL = 'https://platform.claude.com/oauth/code/callback';
/**
 * `setup-token` requests inference scope only. Deliberately mirrored: the
 * broader login scopes are what interactive sign-ins use, and asking for
 * more than the documented headless flow does is how a pairing breaks the
 * day Anthropic tightens what a long-lived token may carry.
 */
const SCOPE = 'user:inference';
/** One year, the `setup-token` default. */
const TOKEN_TTL_SECONDS = 31536000;

/**
 * How long a begun attempt accepts its code. Long enough to sign in on a
 * second device and walk back; short enough that a forgotten tab's link is
 * not a standing credential-shaped thing.
 */
const ATTEMPT_TTL_MS = 10 * 60_000;

export type ClaudePairingAccount = 'claudeai' | 'console';

export interface PairingExchange {
  status: number;
  statusText: string;
  body: unknown;
}

export interface ClaudePairingDeps {
  credentials: { save(value: string): ClaudeCredentialStatus };
  /** The token-endpoint POST, injectable so tests never touch the network. */
  post?: (url: string, body: Record<string, unknown>) => Promise<PairingExchange>;
  /** Overridable for the wire-format test only. */
  tokenUrl?: string;
  now?: () => number;
  log?: (level: 'info' | 'warn', message: string) => void;
}

interface Attempt {
  verifier: string;
  state: string;
  startedAt: number;
}

export class PairingError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'PairingError';
  }
}

export class ClaudePairing {
  /**
   * One attempt, in memory. A restart forgets it — acceptable, because the
   * remedy is one tap on Start again — and a second `begin` replaces it, so
   * there is never a pool of live verifiers to manage or leak.
   */
  private attempt: Attempt | null = null;

  private readonly post: (url: string, body: Record<string, unknown>) => Promise<PairingExchange>;
  private readonly tokenUrl: string;
  private readonly now: () => number;

  constructor(private readonly deps: ClaudePairingDeps) {
    this.post = deps.post ?? defaultPost;
    this.tokenUrl = deps.tokenUrl ?? TOKEN_URL;
    this.now = deps.now ?? Date.now;
  }

  begin(account: ClaudePairingAccount): ClaudePairingStart {
    const verifier = randomBytes(32).toString('base64url');
    const state = randomBytes(32).toString('base64url');
    const startedAt = this.now();
    this.attempt = { verifier, state, startedAt };

    const url = new URL(account === 'console' ? CONSOLE_AUTHORIZE_URL : CLAUDE_AI_AUTHORIZE_URL);
    // `code=true` puts the flow in manual mode: the callback page displays
    // `code#state` for the owner to copy, instead of redirecting to a
    // localhost listener that would be the wrong machine entirely.
    url.searchParams.set('code', 'true');
    url.searchParams.set('client_id', CLIENT_ID);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', MANUAL_REDIRECT_URL);
    url.searchParams.set('scope', SCOPE);
    url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);

    this.deps.log?.('info', 'a Claude pairing attempt was started from the interface');
    return { url: url.toString(), expiresAt: startedAt + ATTEMPT_TTL_MS };
  }

  status(): ClaudePairingState {
    const attempt = this.live();
    return attempt
      ? { active: true, expiresAt: attempt.startedAt + ATTEMPT_TTL_MS }
      : { active: false, expiresAt: null };
  }

  cancel(): void {
    this.attempt = null;
  }

  async complete(pasted: string): Promise<ClaudeCredentialStatus> {
    const attempt = this.live();
    if (!attempt) {
      throw new PairingError(
        this.attempt === null
          ? 'No pairing is in progress here. Start pairing to get a fresh link first.'
          : 'That pairing link has expired. Start pairing again for a fresh one.',
        this.attempt === null ? 409 : 400,
      );
    }

    const trimmed = pasted.trim();
    if (!trimmed) throw new PairingError('Paste the code Claude showed you first.');

    // The callback page displays `code#state`. Some people copy only the
    // code half; the stored state fills in. A state that *is* there and does
    // not match is a different problem than a bad code — an older tab's link
    // — and saying "invalid code" would send the owner retyping forever.
    const hash = trimmed.indexOf('#');
    const code = hash === -1 ? trimmed : trimmed.slice(0, hash);
    const pastedState = hash === -1 ? null : trimmed.slice(hash + 1);
    if (pastedState !== null && pastedState !== attempt.state) {
      throw new PairingError(
        'That code belongs to a different pairing attempt. Use the newest link, or start pairing again.',
      );
    }

    let answer: PairingExchange;
    try {
      answer = await this.post(this.tokenUrl, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: MANUAL_REDIRECT_URL,
        client_id: CLIENT_ID,
        code_verifier: attempt.verifier,
        state: attempt.state,
        expires_in: TOKEN_TTL_SECONDS,
      });
    } catch (error) {
      // The attempt survives: the failure was between this server and
      // Anthropic, and the code may still be good once the network is.
      throw new PairingError(
        `Could not reach Claude's token service: ${(error as Error).message}`,
        502,
      );
    }

    if (answer.status === 401) {
      // Their 401, never ours: the web client treats a 401 from this API as
      // a logged-out session, and being signed out of Metaclaude is the
      // wrong story for a mistyped code.
      throw new PairingError(
        'Claude did not accept that code — mistyped, already used, or too old. Copy it again, or start pairing afresh.',
      );
    }
    if (answer.status !== 200) {
      throw new PairingError(
        `The token exchange failed (${answer.status} ${answer.statusText}). Try again — or pair by pasting a token instead.`,
        502,
      );
    }

    const token = (answer.body as { access_token?: unknown } | null)?.access_token;
    if (typeof token !== 'string' || token.length === 0) {
      throw new PairingError(
        'Claude answered without a token in it. Try again — or pair by pasting a token instead.',
        502,
      );
    }

    // The credential service classifies, seals and applies it — the same
    // path a hand-pasted token takes, so there is exactly one of them.
    const status = this.deps.credentials.save(token);
    this.attempt = null;
    this.deps.log?.('info', 'guided pairing completed; the token was sealed in the vault');
    return status;
  }

  private live(): Attempt | null {
    if (!this.attempt) return null;
    if (this.now() - this.attempt.startedAt > ATTEMPT_TTL_MS) return null;
    return this.attempt;
  }
}

/** The real exchange: JSON in, JSON out, bounded in time. */
async function defaultPost(
  url: string,
  body: Record<string, unknown>,
): Promise<PairingExchange> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const parsed: unknown = await response.json().catch(() => null);
  return { status: response.status, statusText: response.statusText, body: parsed };
}
