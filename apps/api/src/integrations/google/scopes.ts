/**
 * Google grants, mapped to the scopes Google actually understands.
 *
 * One grant, one scope, no bundles. The narrowest scope that does the job is
 * always the one chosen, and two choices here are deliberate rather than
 * obvious:
 *
 *  - **`drive.file`, not `drive`,** for writing. `drive.file` reaches only
 *    files this application itself created or that the user explicitly opened
 *    with it, which is exactly what an agent writing a document needs and
 *    nothing like the read-everything grant `drive` asks for. It is also not
 *    a *restricted* scope, which matters to anyone whose Google project is not
 *    a Workspace internal app.
 *  - **`calendar.events`, not `calendar`,** for writing: events are the thing;
 *    the calendar list, its sharing rules and its settings are not.
 *
 * `openid` and `email` ride along unconditionally, and are not offered as
 * grants because they are not a power — they are how the connection can say
 * *which* account it bound to. Without them a mis-authorised connection (the
 * wrong Google account signed in on that browser) looks identical to the right
 * one, and the operator has no way to notice.
 */

import { GOOGLE_GRANTS, type GoogleGrant } from '@metaclaude/shared';

// No cast, on purpose: `Record<GoogleGrant, string>` makes the compiler check
// that every grant in the shared vocabulary is mapped and that no key is
// invented. Writing this with an `as` first produced a map keyed `drive.file`
// for the grant named `drive.write` — silently unmapped, and only discovered
// at run time as "No Google scope is mapped".
const SCOPE_OF: Record<GoogleGrant, string> = {
  'gmail.read': 'https://www.googleapis.com/auth/gmail.readonly',
  'gmail.send': 'https://www.googleapis.com/auth/gmail.send',
  'calendar.read': 'https://www.googleapis.com/auth/calendar.readonly',
  'calendar.write': 'https://www.googleapis.com/auth/calendar.events',
  'drive.read': 'https://www.googleapis.com/auth/drive.readonly',
  'drive.write': 'https://www.googleapis.com/auth/drive.file',
};

/** Identity scopes, always requested. See the note above. */
export const IDENTITY_SCOPES = ['openid', 'email'] as const;

/**
 * Google scopes that oblige a project to pass Google's verification (and, for
 * a personal account, expire their refresh token after seven days while the
 * consent screen is still in "Testing").
 *
 * Recorded so the interface can *warn* rather than let the operator discover it
 * a week later, when the connection stops working for no visible reason. A
 * Workspace project publishing the app as Internal is exempt.
 */
export const RESTRICTED_GRANTS: readonly GoogleGrant[] = ['gmail.read', 'drive.read'];

/** The scope string for a set of grants: identity first, then one per grant. */
export function scopesFor(grants: readonly GoogleGrant[]): string {
  const seen = new Set<string>(IDENTITY_SCOPES);
  // Iterate the vocabulary rather than the input so the scope string is stable
  // whatever order the checkboxes were ticked in — a stable string is what
  // makes an incremental re-consent comparable to the one before it.
  for (const grant of GOOGLE_GRANTS) {
    if (grants.includes(grant)) seen.add(scopeOf(grant));
  }
  return [...seen].join(' ');
}

/** The single Google scope one grant stands for. */
export function scopeOf(grant: GoogleGrant): string {
  const scope = SCOPE_OF[grant];
  if (!scope) throw new Error(`No Google scope is mapped for grant "${grant}".`);
  return scope;
}
