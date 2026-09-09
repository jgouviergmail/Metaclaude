/**
 * Which section a path belongs to.
 *
 * Here rather than beside the strips that render them, and the reason is
 * measured: `AppShell` needs these predicates to light the rail, `AppShell` is
 * in the entry chunk, and importing them from `SettingsTabs` pulled that whole
 * module — six lucide icons and a component — along with them. The bundle
 * ratchet caught it at +1 kB gzip the day it was written.
 *
 * Same shape as the reason `packages/shared/src/api-contracts.ts` exists: a
 * small thing the entry genuinely needs must not live inside a large thing it
 * does not. No JSX here, deliberately — the moment a table of icons moves in,
 * the saving is gone.
 */

import { SETTINGS_SECTION_PATHS, SYSTEM_SECTION_PATHS } from '@metaclaude/shared';

const owns = (pathname: string, prefix: string): boolean =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

/**
 * The System section: the machine, and what the deployment can do.
 *
 * Read from the shared contract rather than from `SYSTEM_PATHS`, which pairs
 * the same paths with icons — importing it here would drag those into the
 * entry chunk. One list, two readers, and `SystemTabs.test.tsx` holds the
 * strip to it so a screen cannot be added to one and forgotten in the other.
 */
export function isSystemPath(pathname: string): boolean {
  return SYSTEM_SECTION_PATHS.some((prefix) => owns(pathname, prefix));
}

/**
 * The Settings section: the machine, what it spent, its groups, and the manual.
 *
 * From the same shared list as its twin above, rather than from a prefix test.
 * Three of the four screens are not under `/settings` — Server and Analytics
 * each kept their own path when they moved into this section, and `/help`
 * never had one — so a prefix would answer no while the operator stands on
 * them.
 */
export function isSettingsPath(pathname: string): boolean {
  return SETTINGS_SECTION_PATHS.some((prefix) => owns(pathname, prefix));
}
