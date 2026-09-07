/**
 * A workspace's colour square, with its icon inside where there is room.
 *
 * One component because the square was written out six times — the workspaces
 * list, the dashboard, the command palette, and the workspace columns of
 * Agents, Analytics and Memory — and adding the icon to one of them would have
 * left the other five showing a bare square for a workspace that has one. That
 * is the divergence `SectionTabs` exists to have ended, arriving again.
 *
 * The sizes are the ones already in use, and they carry a rule rather than a
 * scale: four of those six sites render a **12px** square, where an icon is
 * not small, it is illegible. So `dot` has no icon at all and renders exactly
 * what it rendered before, and the icon appears only at the two sizes that can
 * hold one. An operator who picks an icon and cannot see it in a list is being
 * told the control does nothing.
 */

import { workspaceIcon } from '@/lib/workspace-icons';
import { cn } from '@/lib/utils';

/** The three sizes the application actually uses, by what they are for. */
const SIZES = {
  /** An 8px marker inside a subtitle. */
  xs: { box: 'size-2 rounded-[3px]', glyph: null },
  /** A 12px marker beside a name. No icon: there is no room for one. */
  dot: { box: 'size-3 rounded-[4px]', glyph: null },
  /**
   * A 16px marker in a page header. Still no icon, and this is the judgement
   * call of the three: a glyph fits at ten pixels and reads as a smudge, and
   * making the header bigger to hold one would change a layout nobody asked
   * about. The icon earns its place where there is room for it.
   */
  sm: { box: 'size-4 rounded', glyph: null },
  /** The dashboard's row. */
  md: { box: 'size-6 rounded-md', glyph: 'size-3.5' },
  /** A card's avatar. */
  lg: { box: 'size-10 rounded-lg', glyph: 'size-5' },
} as const;

export function WorkspaceAvatar({
  color,
  icon,
  size = 'dot',
  className,
}: {
  color: string;
  /** The stored icon name. Empty or unknown renders as a plain square. */
  icon?: string | null;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const spec = SIZES[size];
  const Glyph = spec.glyph ? workspaceIcon(icon) : null;

  return (
    <span
      className={cn('flex shrink-0 items-center justify-center', spec.box, className)}
      style={{ background: color }}
      aria-hidden
    >
      {/*
        White at 90%, not a token: the square is an arbitrary colour the
        operator picked from a ten-swatch palette, so the glyph has to read on
        any of them and cannot follow the theme. All ten are mid-saturation and
        carry white comfortably; a token would follow the *page* instead and go
        invisible on half of them in light mode.
      */}
      {Glyph ? <Glyph className={cn(spec.glyph, 'text-white/90')} strokeWidth={2.25} /> : null}
    </span>
  );
}
