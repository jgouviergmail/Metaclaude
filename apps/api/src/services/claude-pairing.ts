/**
 * Guided pairing — the OAuth flows of the Claude CLI, run by the server.
 *
 * The manual path (run the CLI somewhere, paste what it prints) survives as
 * the fallback, but it assumes a shell, and this deployment is operated from
 * a phone. What the CLI does is a standard OAuth authorization-code exchange
 * with PKCE against Anthropic's public client: build an authorization URL,
 * have the owner approve it in a browser, take the code the callback page
 * displays, and trade it for tokens. Every step of that can be done here, with
 * the browser being the owner's own — which is the one thing they are
 * guaranteed to have.
 *
 * Two kinds, because the CLI has two, and they differ in exactly two ways:
 * which scopes are asked for, and where the answer is put.
 *
 *   `token`   — `claude setup-token`: `user:inference`, a one-year lifetime
 *               asked for explicitly, and the result sealed in the vault.
 *   `account` — `claude auth login`: the six scopes an interactive sign-in
 *               asks for, no lifetime asked for at all, and the result
 *               installed in the CLI's own credentials store. This is the only
 *               credential Anthropic grants the session scope to, which is why
 *               a paired token cannot report plan quota and a sign-in can.
 *
 * The manual redirect is not a workaround for the second: the CLI builds both
 * the localhost link and the paste-the-code link on every sign-in and offers
 * whichever fits. This server can never be the localhost the browser reaches,
 * so it offers the other one — the same flow, not a lesser one.
 *
 * The constants below are Anthropic's, read out of the very CLI binary this
 * image ships (the SDK vendors it), not guessed: the client id, both authorize
 * surfaces, the manual-redirect page that displays `code#state`, the JSON
 * token endpoint, both scope sets, and the one-year `expires_in` that makes a
 * setup token long-lived. They are Anthropic's to change; if they do, the
 * exchange fails loudly with the status it got, and the manual path still
 * works.
 *
 * Security shape: the verifier and state never leave this process — the link
 * carries only the S256 challenge, so a leaked link is unfinishable without
 * the verifier, and a pasted code is bound to the attempt that minted it.
 * Neither token is ever returned to the browser.
 */

import { createHash, randomBytes } from 'node:crypto';
import type {
  ClaudeCliLoginInfo,
  ClaudeCredentialStatus,
  ClaudePairingKind,
  ClaudePairingStart,
  ClaudePairingState,
} from '@metaclaude/shared';
import type { CliLoginTokens } from './claude-cli-login.js';

/** Anthropic's public OAuth client for Claude Code, as shipped in the CLI. */
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLAUDE_AI_AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize';
const CONSOLE_AUTHORIZE_URL = 'https://platform.claude.com/oauth/authorize';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const MANUAL_REDIRECT_URL = 'https://platform.claude.com/oauth/code/callback';
/**
 * `setup-token` requests inference scope only. Deliberately mirrored: asking
 * for more than the documented headless flow does is how a pairing breaks the
 * day Anthropic tightens what a long-lived token may carry.
 */
const SCOPE = 'user:inference';

/**
 * What an interactive `claude auth login` asks for, in its order.
 *
 * Read out of the CLI binary this image ships rather than assembled from what
 * seemed necessary: the list is `[org:create_api_key, user:profile]` unioned
 * with `[user:profile, user:inference, user:sessions:claude_code,
 * user:mcp_servers, user:file_upload]`, deduplicated. Asking for a subset
 * would be an authorization nobody has ever measured the server accepting;
 * asking for more would be a consent screen the owner never agreed to. This
 * is the set, and it is the one that carries the session scope a long-lived
 * token can never have.
 */
const ACCOUNT_SCOPES = [
  'org:create_api_key',
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
];

/** The scope that separates an account sign-in from an inference token. */
const SESSION_SYNC_SCOPE = 'user:sessions:claude_code';

/** Where the account profile — hence the plan label — is read. */
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';

/** One year, the `setup-token` default. */
const TOKEN_TTL_SECONDS = 31536000;

/**
 * How long a begun attempt accepts its code. Long enough to sign in on a
 * second device and walk back; short enough that a forgotten tab's link is
 * not a standing credential-shaped thing.
 */
const ATTEMPT_TTL_MS = 10 * 60_000;

export type ClaudePairingAccount = 'claudeai' | 'console';

/** The two labels the CLI keeps beside a sign-in, read from the profile. */
export interface AccountProfile {
  subscriptionType: string | null;
  rateLimitTier: string | null;
}

export interface PairingExchange {
  status: number;
  statusText: string;
  body: unknown;
}

export interface ClaudePairingDeps {
  credentials: {
    save(value: string, options?: { expiresAt?: number | null }): ClaudeCredentialStatus;
    status(): ClaudeCredentialStatus;
  };
  /** The token-endpoint POST, injectable so tests never touch the network. */
  post?: (url: string, body: Record<string, unknown>) => Promise<PairingExchange>;
  /**
   * Where an account grant goes: the CLI's own credentials store, which is
   * the only place a sign-in can live. Injected rather than imported so the
   * config directory is resolved once, beside the reader.
   */
  installSignIn?: (tokens: CliLoginTokens) => ClaudeCliLoginInfo;
  /**
   * The account profile, for its plan label. Best-effort: a renewal must not
   * fail on decoration.
   */
  profile?: (accessToken: string) => Promise<AccountProfile | null>;
  /** Overridable for the wire-format test only. */
  tokenUrl?: string;
  now?: () => number;
  log?: (level: 'info' | 'warn', message: string) => void;
}

interface Attempt {
  verifier: string;
  state: string;
  startedAt: number;
  kind: ClaudePairingKind;
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
  private readonly profile: (accessToken: string) => Promise<AccountProfile | null>;

  constructor(private readonly deps: ClaudePairingDeps) {
    this.post = deps.post ?? defaultPost;
    this.tokenUrl = deps.tokenUrl ?? TOKEN_URL;
    this.now = deps.now ?? Date.now;
    this.profile = deps.profile ?? defaultProfile;
  }

  begin(account: ClaudePairingAccount, kind: ClaudePairingKind = 'token'): ClaudePairingStart {
    // Asked here rather than at the end: a wizard that cannot be finished
    // should never open, and finding out afterwards costs the owner a spent
    // authorization code for nothing.
    if (kind === 'account' && !this.deps.installSignIn) {
      throw new PairingError(
        'This deployment cannot write the CLI sign-in, so an account sign-in cannot be ' +
          'installed here. Pair a token instead.',
        501,
      );
    }

    const verifier = randomBytes(32).toString('base64url');
    const state = randomBytes(32).toString('base64url');
    const startedAt = this.now();
    this.attempt = { verifier, state, startedAt, kind };

    const url = new URL(account === 'console' ? CONSOLE_AUTHORIZE_URL : CLAUDE_AI_AUTHORIZE_URL);
    // `code=true` puts the flow in manual mode: the callback page displays
    // `code#state` for the owner to copy, instead of redirecting to a
    // localhost listener that would be the wrong machine entirely.
    url.searchParams.set('code', 'true');
    url.searchParams.set('client_id', CLIENT_ID);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', MANUAL_REDIRECT_URL);
    url.searchParams.set('scope', kind === 'account' ? ACCOUNT_SCOPES.join(' ') : SCOPE);
    url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);

    this.deps.log?.(
      'info',
      kind === 'account'
        ? 'a Claude account sign-in was started from the interface'
        : 'a Claude pairing attempt was started from the interface',
    );
    return { url: url.toString(), expiresAt: startedAt + ATTEMPT_TTL_MS, kind };
  }

  status(): ClaudePairingState {
    const attempt = this.live();
    return attempt
      ? { active: true, expiresAt: attempt.startedAt + ATTEMPT_TTL_MS, kind: attempt.kind }
      : { active: false, expiresAt: null, kind: null };
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
        /*
         * A year, and only for a setup token.
         *
         * Measured in the CLI: `expires_in` rides the exchange only when the
         * caller asks for one, and only `setup-token` does. A sign-in's
         * access token is hours long and refreshed from its refresh token —
         * asking for a year here would be asking for a different credential
         * than the one being renewed.
         */
        ...(attempt.kind === 'token' ? { expires_in: TOKEN_TTL_SECONDS } : {}),
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

    if (attempt.kind === 'account') return this.installAccount(answer.body, token);

    /*
     * How long it lasts, from the answer rather than from the request.
     *
     * `expires_in` is what was *granted*; `TOKEN_TTL_SECONDS` is what was
     * asked for, and the two are Anthropic's to diverge. Recording the ask
     * would put a date on the screen that the credential does not honour,
     * which is the same class of untruth as showing the sign-in's date for a
     * token — the defect this field exists to end. The request's value is the
     * fallback only when the answer says nothing.
     */
    const grantedSeconds = (answer.body as { expires_in?: unknown } | null)?.expires_in;
    const seconds = typeof grantedSeconds === 'number' && grantedSeconds > 0
      ? grantedSeconds
      : TOKEN_TTL_SECONDS;

    // The credential service classifies, seals and applies it — the same
    // path a hand-pasted token takes, so there is exactly one of them.
    const status = this.deps.credentials.save(token, {
      expiresAt: this.now() + seconds * 1000,
    });
    this.attempt = null;
    this.deps.log?.('info', 'guided pairing completed; the token was sealed in the vault');
    return status;
  }

  /**
   * Install an account grant as the CLI's own sign-in.
   *
   * Nothing is sealed in the vault here, and that is the design rather than an
   * omission: a stored token *overrides* the sign-in on the very next run, so
   * saving this grant would shadow the credential it was meant to renew. The
   * sign-in lives where the CLI keeps it and the CLI refreshes it from there.
   *
   * Every refusal below happens *after* a successful exchange, which means the
   * code has already been spent — re-pasting it can only ever fail. So the
   * attempt is ended with the same 409 the flow already uses for "there is no
   * attempt here any more", which is what folds the wizard back to its start
   * instead of leaving an owner retyping a dead code. The message carries the
   * cause; the status carries what to do about it.
   */
  private async installAccount(body: unknown, accessToken: string): Promise<ClaudeCredentialStatus> {
    // `begin` refuses an account attempt without a writer, so reaching this
    // with none would be a wiring mistake rather than an owner's problem.
    const install = this.deps.installSignIn;
    if (!install) {
      throw this.spent('This deployment cannot write the CLI sign-in. Pair a token instead.');
    }

    const grant = (body ?? {}) as {
      refresh_token?: unknown;
      expires_in?: unknown;
      refresh_token_expires_in?: unknown;
      scope?: unknown;
    };

    const refreshToken = grant.refresh_token;
    if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
      throw this.spent(
        'Claude answered without a refresh token, so that sign-in could not be kept alive. ' +
          'Start again — or pair a token instead.',
      );
    }

    /*
     * The granted scopes come off the answer, never off the request.
     *
     * What was asked for is not what was granted, and a sign-in that silently
     * came back without the session scope is an inference token wearing the
     * word "renewed". An answer with no `scope` at all is the same refusal for
     * the same reason: nothing here knows what it received.
     */
    const scopes = typeof grant.scope === 'string' ? grant.scope.split(' ').filter(Boolean) : [];
    if (!scopes.includes(SESSION_SYNC_SCOPE)) {
      throw this.spent(
        scopes.length === 0
          ? 'Claude did not say which permissions it granted, so this cannot be installed as an ' +
            'account sign-in. Start again — or pair a token instead.'
          : `Claude granted ${scopes.join(' ')}, without ${SESSION_SYNC_SCOPE}. That is an ` +
            'inference token rather than an account sign-in, and installing it would end the ' +
            'sign-in it was meant to renew.',
      );
    }

    const now = this.now();
    /*
     * An access token with no stated lifetime is treated as already spent
     * rather than as NaN or as a guess: the CLI refreshes on expiry, so the
     * worst case is one extra round trip on the next run. Inventing a duration
     * would put a date on screen that the credential does not honour.
     */
    const accessSeconds = typeof grant.expires_in === 'number' && grant.expires_in > 0
      ? grant.expires_in
      : 0;
    /*
     * Null, not a default. The CLI substitutes thirty days when the grant is
     * silent; doing that here would state an end date Anthropic never issued,
     * on the very screen whose job is to say when the credential stops. Null
     * reads as "unknown", which is the truth.
     */
    const refreshMillis = typeof grant.refresh_token_expires_in === 'number' &&
      grant.refresh_token_expires_in > 0
      ? now + grant.refresh_token_expires_in * 1000
      : null;

    // Decoration, and best-effort accordingly: a renewal that failed on the
    // plan label would leave an approved authorization with no sign-in. Null
    // means "keep whatever the store already had".
    let profile: AccountProfile | null = null;
    try {
      profile = await this.profile(accessToken);
    } catch {
      this.deps.log?.('warn', 'the account profile could not be read; the plan label is unchanged');
    }

    let login: ClaudeCliLoginInfo;
    try {
      login = install({
        accessToken,
        refreshToken,
        expiresAt: now + accessSeconds * 1000,
        refreshTokenExpiresAt: refreshMillis,
        scopes,
        subscriptionType: profile?.subscriptionType ?? null,
        rateLimitTier: profile?.rateLimitTier ?? null,
        clientId: CLIENT_ID,
      });
    } catch (error) {
      // The writer's message is the useful one — a read-only filesystem, a
      // store rewritten in the same instant — and it survives; only the
      // status changes, so the wizard folds instead of offering a dead code.
      throw this.spent((error as Error).message);
    }

    this.attempt = null;
    this.deps.log?.(
      'info',
      `the Claude account sign-in was renewed from the interface (${login.scopes.length} scopes)`,
    );
    return this.deps.credentials.status();
  }

  /**
   * End the attempt and say so.
   *
   * 409 is already this flow's "there is no attempt here any more", and the
   * web client folds the wizard on exactly that. Past the exchange it is the
   * literal truth: the code has been spent, and nothing the owner can type
   * will bring it back.
   */
  private spent(message: string): PairingError {
    this.attempt = null;
    return new PairingError(message, 409);
  }

  private live(): Attempt | null {
    if (!this.attempt) return null;
    if (this.now() - this.attempt.startedAt > ATTEMPT_TTL_MS) return null;
    return this.attempt;
  }
}

/**
 * The account profile, for the two labels the CLI stores beside a sign-in.
 *
 * The plan is *not* a `subscription_type` field — the first version of this
 * assumed one, and it does not exist. Measured in the CLI: the plan is
 * `organization.organization_type`, put through the map below, and the rate
 * limit tier sits beside it. Guessing the shape of a payload is the mistake
 * this repository has made often enough to have a rule about it.
 *
 * Short-timeout and total: every failure answers null, because the caller
 * treats null as "keep what the store had" and a renewal must not fail on
 * decoration.
 */
const PLAN_BY_ORGANIZATION_TYPE = new Map([
  ['claude_max', 'max'],
  ['claude_pro', 'pro'],
  ['claude_enterprise', 'enterprise'],
  ['claude_team', 'team'],
]);

async function defaultProfile(accessToken: string): Promise<AccountProfile | null> {
  try {
    const response = await fetch(PROFILE_URL, {
      headers: { Authorization: `Bearer ${accessToken}`, 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      organization?: { organization_type?: unknown; rate_limit_tier?: unknown };
    } | null;
    const organizationType = body?.organization?.organization_type;
    const tier = body?.organization?.rate_limit_tier;
    return {
      subscriptionType:
        typeof organizationType === 'string'
          ? PLAN_BY_ORGANIZATION_TYPE.get(organizationType) ?? null
          : null,
      rateLimitTier: typeof tier === 'string' && tier.length > 0 ? tier : null,
    };
  } catch {
    return null;
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
