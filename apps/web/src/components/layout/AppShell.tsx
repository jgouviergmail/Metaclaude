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
  Plug,
  Activity,
  LifeBuoy,
  Bot,
  Brain,
  FolderGit2,
  LayoutDashboard,
  Menu as MenuIcon,
  MessageSquare,
  Settings,
  Timer,
} from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useUiStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import { Tooltip } from '@/components/ui/primitives';
import { ConnectionBadge } from './ConnectionBadge';
import { NotificationBell } from './NotificationBell';
import { UserMenu } from './UserMenu';

interface NavEntry {
  to: string;
  label: string;
  icon: ReactNode;
  /** Shown in the phone tab bar. Space is limited, so not everything qualifies. */
  primary?: boolean;
}

const NAV: NavEntry[] = [
  { to: '/', label: 'Dashboard', icon: <LayoutDashboard />, primary: true },
  { to: '/workspaces', label: 'Workspaces', icon: <FolderGit2 />, primary: true },
  { to: '/memory', label: 'Memory', icon: <Brain />, primary: true },
  { to: '/automations', label: 'Automations', icon: <Timer />, primary: true },
  { to: '/agents', label: 'Agents & skills', icon: <Bot /> },
  { to: '/plugins', label: 'Plugins', icon: <Plug /> },
  { to: '/analytics', label: 'Analytics', icon: <Activity /> },
  { to: '/help', label: 'Help', icon: <LifeBuoy /> },
  { to: '/settings', label: 'Settings', icon: <Settings />, primary: true },
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
        aria-label="Sections"
      >
        <NavLink to="/" className="mb-3 flex size-9 items-center justify-center" aria-label="Metaclaude">
          <Logo />
        </NavLink>

        {NAV.map((entry) => (
          <Tooltip key={entry.to} content={entry.label} side="right">
            <NavLink
              to={entry.to}
              end={entry.to === '/'}
              className={({ isActive }) =>
                cn(
                  'flex size-9 items-center justify-center rounded-lg transition-colors',
                  '[&>svg]:size-[18px]',
                  isActive
                    ? 'bg-accent-soft text-accent'
                    : 'text-subtle hover:bg-raised hover:text-ink',
                )
              }
              aria-label={entry.label}
            >
              {entry.icon}
            </NavLink>
          </Tooltip>
        ))}

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
            aria-label="Context"
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
                aria-label="Close panel"
              />
              <aside className="animate-in-up absolute inset-y-0 left-0 flex w-[min(20rem,85vw)] flex-col border-r border-line bg-surface shadow-[var(--mc-shadow-lg)]">
                {sidebar}
              </aside>
            </div>
          ) : null}
        </>
      ) : null}

      {/* Main content. `min-w-0` stops long code blocks from stretching the grid. */}
      <main className="flex min-w-0 flex-1 flex-col pb-14 sm:pb-0">{children}</main>

      {/* Phone tab bar */}
      <nav
        className="fixed inset-x-0 bottom-0 z-30 flex h-14 items-stretch border-t border-line bg-surface/95 backdrop-blur sm:hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        aria-label="Sections"
      >
        {NAV.filter((entry) => entry.primary).map((entry) => (
          <NavLink
            key={entry.to}
            to={entry.to}
            end={entry.to === '/'}
            className={({ isActive }) =>
              cn(
                'flex flex-1 flex-col items-center justify-center gap-0.5 text-[10px] font-medium',
                '[&>svg]:size-[19px]',
                isActive ? 'text-accent' : 'text-subtle',
              )
            }
          >
            {entry.icon}
            {entry.label.split(' ')[0]}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

/** Toolbar button that reveals the contextual sidebar on narrow screens. */
export function SidebarToggle({ className }: { className?: string }) {
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);
  return (
    <button
      type="button"
      onClick={toggleSidebar}
      className={cn(
        'flex size-8 items-center justify-center rounded-lg text-muted hover:bg-raised hover:text-ink',
        className,
      )}
      aria-label="Toggle panel"
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
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  showSidebarToggle?: boolean;
  icon?: ReactNode;
}) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface px-3 sm:px-4">
      {showSidebarToggle ? <SidebarToggle /> : null}
      {icon ? <span className="shrink-0 [&>svg]:size-4">{icon}</span> : null}

      <div className="min-w-0 flex-1">
        <h1 className="truncate text-sm font-semibold text-ink">{title}</h1>
        {subtitle ? <p className="truncate text-[11.5px] text-muted">{subtitle}</p> : null}
      </div>

      {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}

      {/* Phone-only status cluster; on wider screens these live in the rail. */}
      <div className="flex items-center gap-1 sm:hidden">
        <ConnectionBadge />
        <NotificationBell />
      </div>
    </header>
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
