/**
 * The System section: the machine, and what this deployment can do.
 *
 * Six screens were six top-level rail entries out of ten — automations, agents,
 * plugins, analytics, settings, help — and ten does not fit a phone's tab bar,
 * so four of them lived behind a "More" sheet chosen by the available space
 * rather than by meaning.
 *
 * Five belong together: none is something an operator *works in*, all five are
 * what the deployment can do and how it is inspected. Two others left: Settings
 * is where an operator goes deliberately and by name, so it has its own rail
 * entry; Help is the manual, not a capability, and sits with the settings it
 * explains. The machine came the other way — version, resources, the CLI, the
 * doctor, the updater were a tab inside Settings and lead this strip now,
 * because none of it is a preference.
 *
 * Their URLs deliberately do not change. `apps/api` builds links to `/settings`
 * for the Google OAuth return and to `/automations` for a scheduler
 * notification, push notifications carry their own paths, and an operator has
 * bookmarks. The grouping is navigational; nothing moves.
 *
 * The strip itself is `SectionTabs`, shared with Settings — see the note there
 * for why these are links and chips rather than tabs and an underline.
 */

import { Activity, Bot, Plug, Timer } from 'lucide-react';
import { SectionTabs, type SectionPath } from './SectionTabs';
import { useT } from '@/lib/i18n';
import { routes } from '@metaclaude/shared';

export type SystemPath = SectionPath;

/** The four, in the order they are shown. Exported so the rail can own them. */
export const SYSTEM_PATHS: readonly SystemPath[] = [
  // First, because "is the box healthy" comes before "what is it doing".
  { to: routes.automations(), label: 'Automations', icon: <Timer /> },
  { to: routes.agents(), label: 'Agents & skills', icon: <Bot /> },
  { to: routes.plugins(), label: 'Plugins', icon: <Plug /> },
  { to: routes.analytics(), label: 'Analytics', icon: <Activity /> },
];

/**
 * Whether a path belongs to the System section.
 *
 * Re-exported from `lib/sections`, which is where it lives so that `AppShell`
 * — in the entry chunk — can ask the question without pulling this module's
 * five icons in behind it. `SystemTabs.test.tsx` holds the two lists in step.
 */
export { isSystemPath } from '@/lib/sections';

export function SystemTabs({ className }: { className?: string }) {
  const t = useT();
  return <SectionTabs label={t('System sections')} entries={SYSTEM_PATHS} className={className} />;
}
