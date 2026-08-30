/**
 * The CLI's own sign-in, read from its credentials store.
 *
 * `claude auth login`, run interactively in the container, leaves a
 * `.credentials.json` in the CLI's config directory (persisted by the
 * `metaclaude-home` volume) that the CLI maintains and refreshes on its own.
 * That sign-in matters to Metaclaude for one reason: it is the only
 * credential Anthropic grants the session-sync scopes to — long-lived tokens
 * are limited to inference server-side — and an injected
 * `CLAUDE_CODE_OAUTH_TOKEN` *overrides* it. So the credential service needs
 * to know it exists, both to fall back to it when nothing is injected and to
 * tell the owner when what they paired is shadowing it.
 *
 * Read-only on purpose. The file is Anthropic's — its refresh dance, its
 * versioning, its logout marker — and writing it would be forging a login.
 * Anything unreadable or half-shaped answers null rather than throwing:
 * "no usable sign-in" is a normal state, not an error.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ClaudeCliLoginInfo } from '@metaclaude/shared';

/** The slice of `.credentials.json` this reader trusts itself to interpret. */
interface CredentialsFile {
  claudeAiOauth?: {
    accessToken?: unknown;
    refreshToken?: unknown;
    expiresAt?: unknown;
    refreshTokenExpiresAt?: unknown;
    scopes?: unknown;
    subscriptionType?: unknown;
  };
}

/** The scope that separates a full account sign-in from an inference token. */
const SESSION_SYNC_SCOPE = 'user:sessions:claude_code';

export function readCliLogin(configDir: string): ClaudeCliLoginInfo | null {
  let raw: string;
  try {
    raw = readFileSync(join(configDir, '.credentials.json'), 'utf8');
  } catch {
    return null;
  }

  let parsed: CredentialsFile;
  try {
    parsed = JSON.parse(raw) as CredentialsFile;
  } catch {
    return null;
  }

  const oauth = parsed.claudeAiOauth;
  if (!oauth || typeof oauth !== 'object') return null;
  if (typeof oauth.accessToken !== 'string' || oauth.accessToken.length === 0) return null;
  // The CLI marks logout by blanking the refresh token, not by deleting the
  // file. An empty string is an ended sign-in, not a usable one.
  if (oauth.refreshToken === '') return null;
  if (!Array.isArray(oauth.scopes) || !oauth.scopes.every((s) => typeof s === 'string')) {
    return null;
  }

  return {
    full: oauth.scopes.includes(SESSION_SYNC_SCOPE),
    scopes: oauth.scopes,
    subscriptionType: typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : null,
    expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : null,
    // The one that matters. See `ClaudeCliLoginInfo.signInEndsAt`.
    signInEndsAt:
      typeof oauth.refreshTokenExpiresAt === 'number' ? oauth.refreshTokenExpiresAt : null,
  };
}
