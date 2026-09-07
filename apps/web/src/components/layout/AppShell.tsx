/**
 * Application shell.
 *
 * One layout, three form factors:
 *  - Phone: a bottom tab bar; panels become full-screen sheets.
 *  - Tablet: the icon rail, with the contextual sidebar as an overlay.
 *  - Desktop: rail + persistent sidebar + content.
 *
 * The rail is the OS-level navigation (which subsystem am I in); the sidebar is
 * contextual (which session, which file). Keeping those separate is what makes
 * the app navigable with one thumb on a phone.
 */

import {
  Brain,
  FolderGit2,
  LayoutDashboard,
  Menu as MenuIcon,
  MessageSquare,
  Settings,
  SquareKanban,
} from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { isSystemPath } from './SystemTabs';
import { useUiStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import { useT } from '@/lib/i18n';
import { Tooltip } from '@/components/ui/primitives';
import { ConnectionBadge } from './ConnectionBadge';
import { NotificationBell } from './NotificationBell';
import { UserMenu } from './UserMenu';
import { routes, WORKSPACE_PREFIX } from '@metaclaude/shared';

interface NavEntry {
  to: string;
  label: string;
  icon: ReactNode;
  /**
   * Routes this entry owns beyond its own path.
   *
   * `NavLink` decides it is current by comparing the location to its own `to`,
   * so `/w/:id` and `/w/:id/s/:id` matched nothing: the two screens an
   * operator spends the most time in announced no active section at all, and
   * the rail highlighted none.
   */
  matches?: (pathname: string) => boolean;
}

/**
 * Whether an entry owns the current route.
 *
 * Computed here rather than left to `NavLink`, and that is the whole point:
 * `NavLink` derives `aria-current` from its own `isActive` and *overwrites*
 * whatever it is handed, so an entry cannot claim a route outside its `to`.
 * One source of truth, used for both the attribute and the tint.
 */
function isCurrent(entry: NavEntry, pathname: string): boolean {
  if (entry.matches) return entry.matches(pathname);
  if (entry.to === '/') return pathname === '/';
  return pathname === entry.to || pathname.startsWith(`${entry.to}/`);
}

/**
 * Five sections, and every one of them on the phone.
 *
 * There were ten, which does not fit a tab bar, so four lived behind a "More"
 * sheet — and *which* four was decided by the available space rather than by
 * meaning. Six of the ten were the same kind of thing: how this deployment is
 * configured and inspected, never what an operator works in. They are one
 * section now, `SYSTEM_PATHS`, and the rail and the tab bar hold the same five
 * in the same order. Nothing is one tap further away than anything else.
 */
const NAV: NavEntry[] = [
  { to: routes.dashboard(), label: 'Dashboard', icon: <LayoutDashboard /> },
  {
    to: routes.workspaces(),
    label: 'Workspaces',
    icon: <FolderGit2 />,
    matches: (path) => path === routes.workspaces() || path.startsWith(WORKSPACE_PREFIX),
  },
  { to: routes.board(), label: 'Board', icon: <SquareKanban /> },
  { to: routes.memory(), label: 'Memory', icon: <Brain /> },
  {
    // Points at Settings, which is where an operator most often means to go;
    // the section's own strip carries the other five.
    to: routes.settings(),
    label: 'System',
    icon: <Settings />,
    matches: isSystemPath,
  },
];

export function AppShell({
  sidebar,
  children,
}: {
  sidebar?: ReactNode;
  children: ReactNode;
}) {
  const { sidebarOpen, setSidebar } = useUiStore();
  const location = useLocation();
  const t = useT();

  // On a phone the sidebar is an overlay; navigating must dismiss it, or the
  // user lands on a new screen still covered by the old panel.
  useEffect(() => {
    if (window.matchMedia('(max-width: 1023px)').matches) setSidebar(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  return (
    <div className="flex h-full overflow-hidden bg-bg text-ink">
      {/* Icon rail — hidden on phones, where the tab bar takes over. */}
      <nav
        className="hidden w-14 shrink-0 flex-col items-center gap-1 border-r border-line bg-surface py-3 sm:flex"
        aria-label={t('Sections')}
      >
        <NavLink to="/" className="mb-3 flex size-9 items-center justify-center" aria-label="Metaclaude">
          <Logo />
        </NavLink>

        {NAV.map((entry) => {
          const current = isCurrent(entry, location.pathname);
          return (
            <Tooltip key={entry.to} content={t(entry.label)} side="right">
              <Link
                to={entry.to}
                aria-current={current ? 'page' : undefined}
                className={cn(
                  'flex size-9 items-center justify-center rounded-lg transition-colors',
                  '[&>svg]:size-[18px]',
                  current
                    ? 'bg-accent-soft text-accent'
                    : 'text-subtle hover:bg-raised hover:text-ink',
                )}
                aria-label={t(entry.label)}
              >
                {entry.icon}
              </Link>
            </Tooltip>
          );
        })}

        <div className="mt-auto flex flex-col items-center gap-2">
          <ConnectionBadge />
          <NotificationBell />
          <UserMenu />
        </div>
      </nav>

      {/* Contextual sidebar */}
      {sidebar ? (
        <>
          <aside
            className={cn(
              'w-72 shrink-0 border-r border-line bg-surface',
              'hidden lg:flex lg:flex-col',
              !sidebarOpen && 'lg:hidden',
            )}
            aria-label={t('Context')}
          >
            {sidebar}
          </aside>

          {/* Below `lg` the same sidebar is an overlay drawer. */}
          {sidebarOpen ? (
            <div className="fixed inset-0 z-40 lg:hidden">
              <button
                type="button"
                className="absolute inset-0 bg-black/50"
                onClick={() => setSidebar(false)}
                aria-label={t('Close panel')}
              />
              <aside className="animate-in-up absolute inset-y-0 left-0 flex w-[min(20rem,85vw)] flex-col border-r border-line bg-surface shadow-[var(--mc-shadow-lg)]">
                {sidebar}
              </aside>
            </div>
          ) : null}
        </>
      ) : null}

      {/* Main content. `min-w-0` stops long code blocks from stretching the
          grid. The bottom padding mirrors the tab bar's real height: bar plus
          the safe-area inset it grows by on gesture-nav phones — without the
          inset here, an installed PWA hides the last lines behind the bar. */}
      <main className="flex min-w-0 flex-1 flex-col pb-[calc(3.5rem+env(safe-area-inset-bottom))] sm:pb-0">
        {children}
      </main>

      {/* Phone tab bar.

          The safe-area padding and the fixed height live on SEPARATE
          elements, and that separation is load-bearing: with border-box
          sizing, `h-14` + `padding-bottom: env(safe-area-inset-bottom)` on
          one element leaves 56 − ~34 = 22px for the content on a gesture-nav
          phone, and flexbox then crushes the icons to nothing — which is
          exactly how the installed app shipped with miniature icons twice
          while every browser tab (inset 0) looked fine. The outer nav paints
          the home-indicator zone with the bar's own surface; the inner row
          keeps its full 3.5rem, matching what <main> reserves. */}
      <nav
        className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur sm:hidden"
        aria-label={t('Sections')}
      >
        <div className="flex h-14 items-stretch">
          {NAV.map((entry) => {
            const current = isCurrent(entry, location.pathname);
            return (
              <Link
                key={entry.to}
                to={entry.to}
                aria-current={current ? 'page' : undefined}
                className={cn(
                  // Platform floor for a bottom bar: 24px icons, 11px labels.
                  // An installed PWA renders these raw — no browser text
                  // scaling rescues smaller metrics there. shrink-0 so no
                  // future height squeeze can crush the icon again.
                  'flex flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium',
                  '[&>svg]:size-6 [&>svg]:shrink-0',
                  current ? 'text-accent' : 'text-subtle',
                )}
              >
                {entry.icon}
                {t(entry.label).split(' ')[0]}
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}

/** Toolbar button that reveals the contextual sidebar on narrow screens. */
export function SidebarToggle({ className }: { className?: string }) {
  const t = useT();
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);
  return (
    <button
      type="button"
      onClick={toggleSidebar}
      className={cn(
        'flex size-8 items-center justify-center rounded-lg text-muted hover:bg-raised hover:text-ink',
        className,
      )}
      aria-label={t('Toggle panel')}
    >
      <MenuIcon className="size-4" />
    </button>
  );
}

/** Header used by the session view and other full-width screens. */
export function ContentHeader({
  title,
  subtitle,
  actions,
  showSidebarToggle = true,
  icon,
  tabs,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  showSidebarToggle?: boolean;
  icon?: ReactNode;
  /**
   * The section's own navigation, rendered under the header row.
   *
   * It lives here rather than in each page's body so that it sits above the
   * scroll — a strip that scrolled away with the content would stop being
   * navigation. Six screens pass the same `<SystemTabs />`, which is what
   * makes them read as one section without moving a single URL.
   */
  tabs?: ReactNode;
}) {
  return (
    <div className="shrink-0 border-b border-line bg-surface">
      <header className="flex h-14 items-center gap-3 px-3 sm:px-4">
        {showSidebarToggle ? <SidebarToggle /> : null}
        {icon ? <span className="shrink-0 [&>svg]:size-4">{icon}</span> : null}

        {/*
          * The title keeps at least a third of the row.
          *
          * `flex-1` gives it the leftovers, and on a phone there were none: a
          * workspace header carries a New-session button, a settings menu and
          * the three-icon status cluster, so the name was truncated to a single
          * letter — `M` over `C`. Nothing was clipped or covered, so no guard
          * could see it; `truncate` was doing exactly what it is for.
          *
          * Only the subtitle changes here. Giving the title a guaranteed share
          * — `basis-1/3`, or letting the actions shrink — was tried and made
          * things worse: the actions then overlapped the phone status cluster
          * and the bench could not click the bell. The crowding is real and
          * unfixed; it belongs to the final pass, with a measurement rather
          * than a guess.
          */}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-heading text-ink">{title}</h1>
          {subtitle ? (
            <p className="hidden truncate text-caption text-muted sm:block">{subtitle}</p>
          ) : null}
        </div>

        {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}

        {/* Phone-only status cluster; on wider screens these live in the rail. */}
        <div className="flex items-center gap-1 sm:hidden">
          <ConnectionBadge />
          <NotificationBell />
          <UserMenu />
        </div>
      </header>

      {tabs ? <div className="px-3 sm:px-4">{tabs}</div> : null}
    </div>
  );
}

function Logo() {
  return (
    <svg viewBox="0 0 32 32" className="size-7" aria-hidden>
      <defs>
        <linearGradient id="mc-logo" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--mc-accent)" />
          <stop offset="100%" stopColor="var(--mc-thinking)" />
        </linearGradient>
      </defs>
      {/* A ring with an offset gap: the agentic loop, deliberately not closed. */}
      <circle
        cx="16"
        cy="16"
        r="11"
        fill="none"
        stroke="url(#mc-logo)"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray="52 17"
        transform="rotate(-45 16 16)"
      />
      <circle cx="16" cy="16" r="3.5" fill="url(#mc-logo)" />
    </svg>
  );
}
