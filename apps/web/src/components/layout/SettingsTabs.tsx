/**
 * The Settings section: how this deployment is set up, and the manual for it.
 *
 * Settings used to be one screen with Radix tabs: panels swapping in place
 * under a single URL, so nothing could be linked to and the browser's back
 * button walked out of Settings rather than back a group. The System section
 * next to it was already links to routes, and the two read as different kinds
 * of thing while being the same kind of thing. They match now, which is what
 * makes the rail's two entries symmetrical.
 *
 * `/settings` itself is kept and still takes a query, because
 * `integrations.ts` returns from Google's consent there and an operator has
 * bookmarks; it forwards to the group that can read what it carries — see
 * `landingSection`.
 *
 * Help is the last entry and is not a setting. It is the manual, and it sits
 * with the settings it explains rather than among the capabilities in the
 * System strip, where it was the only entry that did not describe something
 * the deployment *does*.
 */

import {
  Activity,
  LifeBuoy,
  Palette,
  Plug2,
  ScrollText,
  Server,
  ShieldCheck,
  SlidersHorizontal,
} from 'lucide-react';
import { SectionTabs, type SectionPath } from './SectionTabs';
import { useT } from '@/lib/i18n';
import { useAuthStore } from '@/lib/store';
import { isOwnerOnlySection, routes, type SettingsSection } from '@metaclaude/shared';

export interface SettingsPath extends SectionPath {
  /** Groups an operator has no business in — the API refuses them too. */
  ownerOnly?: boolean;
}

/**
 * The eight, in the order they are shown.
 *
 * Server leads: what an operator opens Settings *for* is "how is this
 * deployment set up", and the machine it runs on is the first thing that
 * answers — version, resources, the CLI, the doctor, the updater.
 *
 * Analytics second, and it came here from the System strip for the same reason
 * Server did: that strip is what the deployment *does*, and consumption is not
 * a capability. It belongs next to the machine — what it ran on, and what that
 * cost — and both are read deliberately rather than passed through. Like
 * Server, it kept its own path, which is why neither is built from
 * `settingsSection`.
 *
 * Appearance next because it is the one changed on a whim; connections and
 * security after; configuration and the audit log then, as the things you go
 * in for deliberately; help last.
 *
 * `ownerOnly` is read from the shared contract rather than written here: the
 * API refuses the same three, and two spellings of one rule eventually
 * disagree — as a hidden screen, or an unguarded one.
 */
export const SETTINGS_PATHS: readonly SettingsPath[] = [
  { to: routes.server(), label: 'Server', icon: <Server /> },
  { to: routes.analytics(), label: 'Analytics', icon: <Activity /> },
  { to: routes.settingsSection('appearance'), label: 'Appearance', icon: <Palette /> },
  {
    to: routes.settingsSection('connections'),
    label: 'Connections',
    icon: <Plug2 />,
    ownerOnly: isOwnerOnlySection('connections'),
  },
  { to: routes.settingsSection('security'), label: 'Security', icon: <ShieldCheck /> },
  {
    to: routes.settingsSection('configuration'),
    label: 'Configuration',
    icon: <SlidersHorizontal />,
    ownerOnly: isOwnerOnlySection('configuration'),
  },
  {
    to: routes.settingsSection('audit'),
    label: 'Audit log',
    icon: <ScrollText />,
    ownerOnly: isOwnerOnlySection('audit'),
  },
  { to: routes.help(), label: 'Help', icon: <LifeBuoy /> },
];

/**
 * Whether a path belongs to the Settings section.
 *
 * Re-exported from `lib/sections` — see the note there: `AppShell` is in the
 * entry chunk and must not drag this module's icons into it.
 */
export { isSettingsPath } from '@/lib/sections';

/** The group a bare `/settings` should forward to, given its query. */
export function landingSection(search: string): SettingsSection {
  // Google's callback returns to `/settings?google=connected|failed`, and the
  // toast that reports the outcome lives in the connection card — which is
  // only mounted on its own route now. Landing anywhere else would swallow the
  // outcome entirely: no card, no effect, no toast.
  return new URLSearchParams(search).has('google') ? 'connections' : 'appearance';
}

export function SettingsTabs({ className }: { className?: string }) {
  const t = useT();
  const role = useAuthStore((state) => state.user?.role);
  const visible = SETTINGS_PATHS.filter((entry) => !entry.ownerOnly || role === 'owner');
  return <SectionTabs label={t('Settings sections')} entries={visible} className={className} />;
}
