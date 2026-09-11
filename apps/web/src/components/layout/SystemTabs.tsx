/**
 * The System section: what this deployment can do.
 *
 * Six screens were six top-level rail entries out of ten, and ten does not fit
 * a phone's tab bar, so four lived behind a "More" sheet chosen by the
 * available space rather than by meaning. Grouping them ended that.
 *
 * What is left here is a capability each: an automation, an agent or a skill,
 * a plugin. None is something an operator *works in*, and none is a setting.
 * The screens that left did so on that test rather than on how full the strip
 * was — Help is the manual, the machine is not a capability but the thing
 * capabilities run on, and Analytics answers what has already been spent
 * rather than what can be done. All three sit in Settings now.
 *
 * Their URLs deliberately do not change, here or when one leaves. `apps/api`
 * builds links to `/settings` for the Google OAuth return and to
 * `/automations` for a scheduler notification, push notifications carry their
 * own paths, and an operator has bookmarks. The grouping is navigational; what
 * has to follow a move is which rail entry lights up, which is why
 * `packages/shared/src/routes.ts` holds one list per section and the tests
 * derive from it rather than restating it.
 *
 * The strip itself is `SectionTabs`, shared with Settings — see the note there
 * for why these are links and chips rather than tabs and an underline.
 */

import { Bot, Plug, Timer, Wrench } from 'lucide-react';
import { SectionTabs, type SectionPath } from './SectionTabs';
import { useT } from '@/lib/i18n';
import { routes } from '@metaclaude/shared';

export type SystemPath = SectionPath;

/**
 * The four, in the order they are shown. Exported so the rail can own them.
 *
 * Analytics was here once and left for Settings. It never described something
 * the deployment *does*, which is what this strip is: it answers what the
 * deployment has already spent, which is read deliberately and beside the
 * machine that ran it.
 *
 * CLI tools passes the same test from the other direction. The Claude CLI
 * brings a tool set of its own, and it is written for someone at a terminal
 * signed in to claude.ai — `Artifact` publishes a page there from inside a
 * run, `CronCreate` schedules work outside the automations screen and its
 * quota guard. Which of those the agent has is a capability of this
 * deployment, not a preference about one project, and it belongs last because
 * it is the layer underneath the other three rather than something an
 * operator visits often.
 */
export const SYSTEM_PATHS: readonly SystemPath[] = [
  { to: routes.automations(), label: 'Automations', icon: <Timer /> },
  { to: routes.agents(), label: 'Agents & skills', icon: <Bot /> },
  { to: routes.plugins(), label: 'Plugins', icon: <Plug /> },
  { to: routes.cliTools(), label: 'CLI tools', icon: <Wrench /> },
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
