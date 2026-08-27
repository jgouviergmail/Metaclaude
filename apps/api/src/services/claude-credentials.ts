/**
 * The Claude credential, and where it is allowed to come from.
 *
 * Until now the only source was the environment, which means `.env` on the
 * server, which means SSH. That is a poor fit for the deployment this is: a
 * private OS reached from a phone and a tablet, where the owner may have no
 * shell at all — and the credential is the one thing without which nothing in
 * the product works. So it can also be set from the interface, and when it is,
 * it is sealed in the vault under the master key rather than written to a file.
 *
 * Resolution order, most specific first:
 *
 *   1. a subscription token stored from the interface
 *   2. an API key stored from the interface
 *   3. CLAUDE_CODE_OAUTH_TOKEN from the environment
 *   4. ANTHROPIC_API_KEY from the environment
 *   5. the CLI's own account sign-in (`claude auth login` in the container)
 *
 * The stored value wins because it is the one the owner set most recently and
 * most deliberately; the environment remains the way to bootstrap a machine
 * that has never been signed in to.
 *
 * The fifth source is different in kind: Metaclaude injects *nothing* for it.
 * The CLI reads its own credentials store precisely when no token variable is
 * set — an injected token overrides the sign-in, the CLI says so itself — so
 * falling back here means leaving both variables unset on purpose. It is also
 * the only credential Anthropic grants the session-sync scopes to (mirroring
 * to claude.ai, Remote Control, teleport): long-lived tokens are limited to
 * inference server-side. The status always carries what the CLI store holds,
 * so the interface can tell the owner when a paired token is shadowing a
 * full-scope sign-in they may actually want.
 *
 * The environment object handed to the supervisor is mutated in place rather
 * than rebuilt. The supervisor reads it once per run, so a credential set from
 * the interface takes effect on the very next prompt — no restart, which is
 * the entire point of being able to set it from a phone.
 */

import type { ClaudeCliLoginInfo, ClaudeCredentialStatus } from '@metaclaude/shared';
import type { Vault } from '../security/vault.js';

/** Vault slots. Global scope: the credential is the deployment's, not a workspace's. */
const TOKEN_KEY = 'claude.oauth_token';
const API_KEY_KEY = 'claude.api_key';

export interface ClaudeCredentialsDeps {
  vault: Vault;
  /** The live environment handed to the supervisor and the reflector. */
  env: Record<string, string>;
  /** Values read from the process environment at boot. */
  fromEnvironment: { oauthToken: string | null; apiKey: string | null };
  /** The CLI's own sign-in, when its store holds one. See claude-cli-login.ts. */
  cliLogin?: () => ClaudeCliLoginInfo | null;
  log?: (level: 'info' | 'warn', message: string) => void;
}

/**
 * A subscription token from `claude setup-token`. Prefix-checked rather than
 * pattern-matched on its length: the shape is Anthropic's to change, and
 * rejecting a token the CLI would have accepted is the worse failure — the
 * owner cannot tell it from "my subscription does not work".
 */
function looksLikeOauthToken(value: string): boolean {
  return value.startsWith('sk-ant-oat');
}

function looksLikeApiKey(value: string): boolean {
  return value.startsWith('sk-ant-api');
}

/** Last four characters, which is all anyone needs to tell two tokens apart. */
function hint(value: string): string {
  return `…${value.slice(-4)}`;
}

export class ClaudeCredentials {
  constructor(private readonly deps: ClaudeCredentialsDeps) {
    this.apply();
  }

  private stored(): { token: string | null; apiKey: string | null } {
    return {
      token: this.deps.vault.get('global', TOKEN_KEY),
      apiKey: this.deps.vault.get('global', API_KEY_KEY),
    };
  }

  /**
   * Recompute the credential and write it into the shared environment.
   *
   * Both variables are deleted first. Leaving a stale `ANTHROPIC_API_KEY`
   * behind after the owner pairs a subscription would bill them per token while
   * the subscription they are paying for sits unused — silently, because both
   * credentials work.
   */
  private apply(): ClaudeCredentialStatus {
    const { token, apiKey } = this.stored();
    delete this.deps.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete this.deps.env.ANTHROPIC_API_KEY;
    const cliLogin = this.deps.cliLogin?.() ?? null;

    if (token) {
      this.deps.env.CLAUDE_CODE_OAUTH_TOKEN = token;
      return { mode: 'subscription', source: 'stored', hint: hint(token), cliLogin };
    }
    if (apiKey) {
      this.deps.env.ANTHROPIC_API_KEY = apiKey;
      return { mode: 'api_key', source: 'stored', hint: hint(apiKey), cliLogin };
    }
    if (this.deps.fromEnvironment.oauthToken) {
      this.deps.env.CLAUDE_CODE_OAUTH_TOKEN = this.deps.fromEnvironment.oauthToken;
      return {
        mode: 'subscription',
        source: 'environment',
        hint: hint(this.deps.fromEnvironment.oauthToken),
        cliLogin,
      };
    }
    if (this.deps.fromEnvironment.apiKey) {
      this.deps.env.ANTHROPIC_API_KEY = this.deps.fromEnvironment.apiKey;
      return {
        mode: 'api_key',
        source: 'environment',
        hint: hint(this.deps.fromEnvironment.apiKey),
        cliLogin,
      };
    }
    if (cliLogin) {
      // Nothing injected, on purpose: the CLI reads its own store exactly
      // when no token variable is set, and setting one would override the
      // sign-in this branch exists to hand over to.
      return { mode: 'subscription', source: 'cli-login', hint: null, cliLogin };
    }
    return { mode: 'none', source: null, hint: null, cliLogin: null };
  }

  status(): ClaudeCredentialStatus {
    return this.apply();
  }

  /**
   * Store a credential set from the interface.
   *
   * Which kind it is comes from the value, not from the caller: an owner
   * pasting into a box should not also have to classify what they pasted, and
   * the two prefixes are unambiguous.
   */
  save(value: string): ClaudeCredentialStatus {
    const trimmed = value.trim();
    if (!trimmed) throw new CredentialError('Paste a token first.');

    if (looksLikeOauthToken(trimmed)) {
      this.deps.vault.set('global', TOKEN_KEY, trimmed);
      this.deps.vault.delete('global', API_KEY_KEY);
      this.deps.log?.('info', 'a Claude subscription token was stored from the interface');
    } else if (looksLikeApiKey(trimmed)) {
      this.deps.vault.set('global', API_KEY_KEY, trimmed);
      this.deps.vault.delete('global', TOKEN_KEY);
      this.deps.log?.('info', 'an Anthropic API key was stored from the interface');
    } else {
      throw new CredentialError(
        'That does not look like a Claude credential. A subscription token from ' +
          '`claude setup-token` begins with sk-ant-oat, and an API key begins with sk-ant-api.',
      );
    }
    return this.apply();
  }

  /** Forget the stored credential. The environment, if any, takes over again. */
  clear(): ClaudeCredentialStatus {
    this.deps.vault.delete('global', TOKEN_KEY);
    this.deps.vault.delete('global', API_KEY_KEY);
    this.deps.log?.('info', 'the stored Claude credential was removed');
    return this.apply();
  }
}

export class CredentialError extends Error {
  readonly statusCode = 400;
}
