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
 * Reading is total: anything unreadable or half-shaped answers null rather
 * than throwing, because "no usable sign-in" is a normal state, not an error.
 *
 * Writing exists, and the line it does not cross is worth stating. Forging a
 * login would be putting values in this file that Anthropic never issued.
 * `writeCliLogin` puts in exactly what Anthropic's token endpoint returned for
 * an authorization the owner approved in their own browser, through the same
 * OAuth client, the same manual redirect and the same scopes `claude auth
 * login` uses — all four read out of the CLI binary this image ships. It is
 * the sign-in the CLI would have written for itself, obtained the way the CLI
 * obtains it, on a machine whose only missing ingredient is a terminal.
 *
 * Everything else about the file stays the CLI's: the refresh dance, the
 * logout marker, and every key this module has never heard of are left exactly
 * where they were.
 */

import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
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

/** What a token exchange yields, in the shape the CLI's own store uses. */
export interface CliLoginTokens {
  accessToken: string;
  refreshToken: string;
  /** The access token's expiry, in millis. Hours out; the CLI rotates it. */
  expiresAt: number;
  /** The sign-in's own end, or null when the grant did not state one. */
  refreshTokenExpiresAt: number | null;
  scopes: string[];
  /** From the profile call, when it answered. Null keeps whatever is stored. */
  subscriptionType: string | null;
  /** Likewise, and stored beside the plan by the CLI itself. */
  rateLimitTier: string | null;
  /** The OAuth client the grant was issued to; the CLI refreshes against it. */
  clientId: string;
}

export class CliLoginWriteError extends Error {
  readonly statusCode = 502;
}

/**
 * Install a fresh account sign-in in the CLI's store.
 *
 * Three properties this has to hold, each of which cost thought:
 *
 * 1. **Nothing else in the file may move.** The CLI keeps its design OAuth
 *    node, the account record and a trusted-device token in the same object.
 *    The CLI's own merge rebuilds the sign-in node from a fixed list of seven
 *    fields — it can, it wrote every one of them — but this code deliberately
 *    spreads over what it finds instead: deleting a key because you do not
 *    recognise it is the opposite of caution in a file you do not own.
 *
 * 2. **A grant that does not restate a value must not blank it.** Measured in
 *    the shipped binary: the CLI carries `subscriptionType`, `rateLimitTier`
 *    and `refreshTokenExpiresAt` forward across a refresh that omits them.
 *    Doing otherwise would show an owner on Max as being on no plan at all.
 *
 * 3. **A downgrade is refused rather than written.** An inference-only grant
 *    is what a paired token already is; installing one here would *end* the
 *    account sign-in — session sync, MCP servers, the plan windows the quota
 *    screen reads — under a message saying it had been renewed.
 *
 * The write itself is a rename over a uniquely-named temporary, so no reader
 * ever sees half a credentials file, and two writers cannot fight over one
 * `.part` name. The return value is what `readCliLogin` makes of the bytes,
 * not a copy of the argument: a write the reader cannot use is a failed
 * renewal however well the exchange went.
 */
export function writeCliLogin(configDir: string, tokens: CliLoginTokens): ClaudeCliLoginInfo {
  if (!tokens.scopes.includes(SESSION_SYNC_SCOPE)) {
    throw new CliLoginWriteError(
      `Claude granted ${tokens.scopes.join(' ') || 'no scopes'}, without ` +
        `${SESSION_SYNC_SCOPE} — that is an inference token, not an account sign-in, ` +
        'and installing it would end the sign-in it was meant to renew.',
    );
  }

  const path = join(configDir, '.credentials.json');

  // A file that does not parse holds nothing worth preserving, and the owner
  // has just approved an authorization: refusing here would leave them with no
  // way through at all.
  let existing: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
    /* absent, unreadable or malformed — start from an empty object */
  }

  const previous =
    existing.claudeAiOauth !== null &&
    typeof existing.claudeAiOauth === 'object' &&
    !Array.isArray(existing.claudeAiOauth)
      ? (existing.claudeAiOauth as Record<string, unknown>)
      : {};

  const next = {
    ...previous,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    refreshTokenExpiresAt: tokens.refreshTokenExpiresAt ?? previous.refreshTokenExpiresAt ?? null,
    scopes: tokens.scopes,
    subscriptionType: tokens.subscriptionType ?? previous.subscriptionType ?? null,
    rateLimitTier: tokens.rateLimitTier ?? previous.rateLimitTier ?? null,
    clientId: tokens.clientId,
  };

  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    // A machine the CLI has never run on has no config directory at all, and
    // signing in for the first time is exactly when that is true.
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    writeFileSync(temporary, `${JSON.stringify({ ...existing, claudeAiOauth: next }, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    // `writeFileSync`'s mode only applies at creation, and umask can still
    // narrow it; an existing temporary would keep whatever it had.
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      /* it may never have been created */
    }
    throw new CliLoginWriteError(
      `The sign-in could not be written to the CLI's store: ${(error as Error).message}`,
    );
  }

  /*
   * Read back, and check it is *this* sign-in.
   *
   * The CLI owns this file and rewrites it whenever it refreshes, which it may
   * be doing inside a run happening right now. A rename cannot be interleaved,
   * but two renames can be ordered the other way round — and then the store
   * holds the sign-in from before the renewal while this code reports success.
   * Reading back only far enough to say "signed in" would not see that;
   * comparing the access token does. There is no lock to take here: the CLI's
   * protocol is its own, and the honest answer to losing the race is to say so
   * and let the owner press the button again.
   */
  const written = readCliLogin(configDir);
  if (!written) {
    throw new CliLoginWriteError(
      "The sign-in was written but the CLI's store does not read back as signed in.",
    );
  }
  if (!sameAccessToken(path, tokens.accessToken)) {
    throw new CliLoginWriteError(
      'The CLI rewrote its credentials store at the same moment, so the renewal did not stick. ' +
        'Start again — nothing was lost.',
    );
  }
  return written;
}

/** Whether the store still holds the access token this write put there. */
function sameAccessToken(path: string, accessToken: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      claudeAiOauth?: { accessToken?: unknown };
    };
    return parsed.claudeAiOauth?.accessToken === accessToken;
  } catch {
    return false;
  }
}
