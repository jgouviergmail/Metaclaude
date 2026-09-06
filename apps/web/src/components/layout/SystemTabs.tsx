/**
 * The System section's own navigation.
 *
 * Six screens were six top-level rail entries out of ten — automations, agents,
 * plugins, analytics, settings, help — and ten does not fit a phone's tab bar,
 * so four of them lived behind a "More" sheet chosen by the available space
 * rather than by meaning. They belong together: none is something an operator
 * *works in*, all six are how the deployment is configured and inspected.
 *
 * Their URLs deliberately do not change. `apps/api` builds links to `/settings`
 * for the Google OAuth return and to `/automations` for a scheduler
 * notification, push notifications carry their own paths, and an operator has
 * bookmarks. The grouping is navigational; nothing moves.
 *
 * Links rather than tabs, and the distinction is not pedantic: `role="tab"`
 * promises a panel switching in place under the same URL. These change the
 * route, so a screen reader is told what is true — a navigation landmark whose
 * current entry carries `aria-current="page"`.
 *
 * Chips, not an underlined strip, and that is not decoration either. Settings
 * carries six tabs of its own, and the first version of this drew both in the
 * same register: two scrolling strips stacked, identical, ninety pixels of a
 * phone's height, with nothing saying which one moved between screens and
 * which one moved within a screen. Two levels of navigation exist here, so
 * they read as two.
 */

import { Activity, Bot, LifeBuoy, Plug, Settings, Timer } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export interface SystemPath {
  to: string;
  label: string;
  icon: ReactNode;
}

/** The six, in the order they are shown. Exported so the rail can own them. */
export const SYSTEM_PATHS: readonly SystemPath[] = [
  { to: '/automations', label: 'Automations', icon: <Timer /> },
  { to: '/agents', label: 'Agents & skills', icon: <Bot /> },
  { to: '/plugins', label: 'Plugins', icon: <Plug /> },
  { to: '/analytics', label: 'Analytics', icon: <Activity /> },
  { to: '/settings', label: 'Settings', icon: <Settings /> },
  { to: '/help', label: 'Help', icon: <LifeBuoy /> },
];

/** Whether a path belongs to the System section. */
export function isSystemPath(pathname: string): boolean {
  return SYSTEM_PATHS.some((entry) => pathname === entry.to || pathname.startsWith(`${entry.to}/`));
}

export function SystemTabs({ className }: { className?: string }) {
  const t = useT();
  const { pathname } = useLocation();
  const currentRef = useRef<HTMLAnchorElement | null>(null);

  /*
   * Bring the current chip into view.
   *
   * Six French labels are wider than a phone, so the strip scrolls — and it
   * scrolls from the left, which put the current chip off-screen on every
   * System screen at 390px: the one thing a section strip exists to show was
   * the one thing it did not. `nearest` on the block axis so the page itself
   * never jumps, and no smooth behaviour, which would be motion nobody asked
   * for on a load.
   */
  useEffect(() => {
    currentRef.current?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }, [pathname]);

  return (
    <nav
      aria-label={t('System sections')}
      // Scrolls rather than wraps: six French labels do not fit 390px, and a
      // strip that wraps to two rows pushes the content down on every phone.
      // `scripts/responsive.mjs` tolerates a control outside the frame only
      // when an ancestor genuinely scrolls, which is what makes this a choice.
      className={cn('flex gap-1.5 overflow-x-auto py-2', className)}
    >
      {SYSTEM_PATHS.map((entry) => {
        const current = pathname === entry.to || pathname.startsWith(`${entry.to}/`);
        return (
          <Link
            key={entry.to}
            to={entry.to}
            ref={current ? currentRef : undefined}
            aria-current={current ? 'page' : undefined}
            className={cn(
              'flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5',
              'text-label font-medium transition-colors [&>svg]:size-3.5',
              current
                ? 'bg-accent-soft text-accent'
                : 'text-muted hover:bg-raised hover:text-ink',
            )}
          >
            {entry.icon}
            {t(entry.label)}
          </Link>
        );
      })}
    </nav>
  );
}
