/**
 * Command palette (⌘K).
 *
 * The fastest path to anywhere in the OS, and on a keyboard the primary one.
 * It searches workspaces, sessions and navigation targets in one list, because
 * the operator is thinking "the auth refactor", not "which section is that in".
 */

import { Command } from 'cmdk';
import {
  Activity,
  Bot,
  Brain,
  FolderGit2,
  LayoutDashboard,
  MessageSquare,
  Plus,
  Settings,
  Timer,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { cn, formatRelative } from '@/lib/utils';

interface Action {
  id: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  group: string;
  run: () => void;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Only fetched while the palette is open, so it costs nothing when closed.
  const { data: workspaceData } = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => api.workspaces(),
    enabled: open,
    staleTime: 30_000,
  });

  const { data: runData } = useQuery({
    queryKey: ['runs', 'recent'],
    queryFn: () => api.runs({ limit: 12 }),
    enabled: open,
    staleTime: 15_000,
  });

  const go = (path: string): (() => void) => () => {
    setOpen(false);
    navigate(path);
  };

  const actions: Action[] = [
    { id: 'nav-dashboard', label: 'Dashboard', icon: <LayoutDashboard />, group: 'Go to', run: go('/') },
    { id: 'nav-workspaces', label: 'Workspaces', icon: <FolderGit2 />, group: 'Go to', run: go('/workspaces') },
    { id: 'nav-memory', label: 'Memory', icon: <Brain />, group: 'Go to', run: go('/memory') },
    { id: 'nav-automations', label: 'Automations', icon: <Timer />, group: 'Go to', run: go('/automations') },
    { id: 'nav-agents', label: 'Agents & skills', icon: <Bot />, group: 'Go to', run: go('/agents') },
    { id: 'nav-analytics', label: 'Analytics', icon: <Activity />, group: 'Go to', run: go('/analytics') },
    { id: 'nav-settings', label: 'Settings', icon: <Settings />, group: 'Go to', run: go('/settings') },
    {
      id: 'new-workspace',
      label: 'New workspace',
      hint: 'Create a project',
      icon: <Plus />,
      group: 'Create',
      run: go('/workspaces?new=1'),
    },
  ];

  for (const workspace of workspaceData?.workspaces ?? []) {
    actions.push({
      id: `ws-${workspace.id}`,
      label: workspace.name,
      hint: workspace.description || workspace.slug,
      icon: (
        <span
          className="block size-3 rounded-[4px]"
          style={{ background: workspace.color }}
          aria-hidden
        />
      ),
      group: 'Workspaces',
      run: go(`/w/${workspace.id}`),
    });
  }

  for (const run of runData?.runs ?? []) {
    actions.push({
      id: `run-${run.id}`,
      label: run.prompt.split('\n')[0]?.slice(0, 80) ?? 'Untitled run',
      hint: `${run.status} · ${formatRelative(run.startedAt)}`,
      icon: <MessageSquare />,
      group: 'Recent sessions',
      run: go(`/w/${run.workspaceId}/s/${run.sessionId}`),
    });
  }

  const groups = [...new Set(actions.map((action) => action.group))];

  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      label="Command palette"
      shouldFilter
      className="fixed inset-0 z-50"
      // cmdk renders its own dialog; the overlay and panel are styled below.
      overlayClassName="fixed inset-0 bg-black/50 backdrop-blur-[2px]"
      contentClassName={cn(
        'animate-in-up fixed left-1/2 top-[12vh] w-[min(38rem,92vw)] -translate-x-1/2',
        'overflow-hidden rounded-2xl border border-line bg-raised shadow-[var(--mc-shadow-lg)]',
      )}
    >
      <Command.Input
        placeholder="Search workspaces, sessions and commands…"
        className="h-12 w-full border-b border-line bg-transparent px-4 text-[15px] text-ink outline-none placeholder:text-subtle"
      />

      <Command.List className="max-h-[min(26rem,60vh)] overflow-y-auto p-2">
        <Command.Empty className="px-3 py-8 text-center text-[13px] text-muted">
          Nothing matches that.
        </Command.Empty>

        {groups.map((group) => (
          <Command.Group
            key={group}
            heading={group}
            className="mb-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-subtle"
          >
            {actions
              .filter((action) => action.group === group)
              .map((action) => (
                <Command.Item
                  key={action.id}
                  value={`${action.label} ${action.hint ?? ''}`}
                  onSelect={action.run}
                  className={cn(
                    'flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px]',
                    'text-ink data-[selected=true]:bg-surface',
                  )}
                >
                  <span className="shrink-0 text-subtle [&>svg]:size-4">{action.icon}</span>
                  <span className="min-w-0 flex-1 truncate font-medium">{action.label}</span>
                  {action.hint ? (
                    <span className="max-w-[45%] shrink-0 truncate text-[11.5px] text-subtle">
                      {action.hint}
                    </span>
                  ) : null}
                </Command.Item>
              ))}
          </Command.Group>
        ))}
      </Command.List>
    </Command.Dialog>
  );
}
