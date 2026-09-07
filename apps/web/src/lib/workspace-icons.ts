/**
 * The icons a workspace may wear, as a closed table.
 *
 * Closed on purpose, and the reason is the bundle rather than taste. Lucide
 * ships some fifteen hundred icons; anything that resolved a *stored string*
 * to a component at run time would have to reach them all, and this table is
 * imported by the avatar, which the command palette renders — so it lands in
 * the chunk the shell preloads. Fourteen static imports are a few hundred
 * bytes there; a dynamic registry would be tens of kilobytes.
 *
 * The keys are what `Workspace.icon` stores, and two of them are already in
 * production databases: `folder` is what workspace creation has always
 * written, and `bot` is what the system workspace gives itself. Neither had
 * ever been *rendered* — the field was stored, accepted by the PATCH route,
 * and shown nowhere, which is the "a schema field nothing forwards" shape this
 * repository keeps finding. Removing either key would blank an icon somebody
 * already has.
 *
 * An unknown key renders as no icon rather than as a fallback glyph: a
 * workspace whose icon was removed, and one carrying a name this table no
 * longer knows, should look the same — a plain coloured square, which is
 * exactly what every workspace looked like before this existed.
 */

import {
  Bot,
  BookOpen,
  Briefcase,
  Code,
  Compass,
  FlaskConical,
  Folder,
  Globe,
  Hammer,
  Home,
  Rocket,
  ShieldCheck,
  Sparkles,
  Terminal,
  type LucideIcon,
} from 'lucide-react';

/** Every icon a workspace may store, keyed by the string on the row. */
export const WORKSPACE_ICONS: Readonly<Record<string, LucideIcon>> = {
  folder: Folder,
  bot: Bot,
  code: Code,
  terminal: Terminal,
  globe: Globe,
  book: BookOpen,
  briefcase: Briefcase,
  flask: FlaskConical,
  hammer: Hammer,
  rocket: Rocket,
  shield: ShieldCheck,
  sparkles: Sparkles,
  compass: Compass,
  home: Home,
};

/** The keys, in the order a picker offers them. */
export const WORKSPACE_ICON_NAMES = Object.keys(WORKSPACE_ICONS);

/**
 * The component for a stored name, or null.
 *
 * Null for the empty string — an operator who removed the icon — and null for
 * a name this table does not know, which is the same picture on purpose. A
 * fallback glyph would tell those two apart to nobody's benefit and would give
 * every workspace an icon it never chose.
 */
export function workspaceIcon(name: string | null | undefined): LucideIcon | null {
  if (!name) return null;
  return WORKSPACE_ICONS[name] ?? null;
}
