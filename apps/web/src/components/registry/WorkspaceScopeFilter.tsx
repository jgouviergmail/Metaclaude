/**
 * Which workspaces a listing covers — one control, four screens.
 *
 * Two things were wrong and they compounded. The control lived in the page
 * header, beside the title, while every *other* filter on the same screen sat
 * in a row above the list; so the one question that changes the listing most
 * was the one question that did not look like a filter. And its widest answer
 * was "Global", meaning only the definitions attached to no workspace in
 * particular — so a skill attached to one workspace was invisible from every
 * other scope, and there was no way at all to see the library whole.
 *
 * The API had `?scope=all` from the day the reach became a many-to-many, with a
 * comment saying exactly why: "a missing query parameter must not collapse to
 * null, or there would be no way to list everything — which is exactly what a
 * management screen needs". Nothing ever asked for it.
 *
 * `withGlobal: false` is for a screen where the tier does not exist. Analytics
 * ranks runs, and a run belongs to a workspace: "global runs" is not a thing,
 * and offering it would be a control that returns an empty list forever. Same
 * placement, same shape, one fewer answer — homogeneous where it is true.
 */

import { ChevronDown, Filter } from 'lucide-react';
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '@/components/ui/Menu';
import { Button } from '@/components/ui/primitives';
import { WorkspaceAvatar } from '@/components/workspace/WorkspaceAvatar';
import { useT } from '@/lib/i18n';

/** `all` = every scope; `global` = unattached definitions; else a workspace id. */
export type WorkspaceScope = 'all' | 'global' | (string & {});

export interface ScopeWorkspace {
  id: string;
  name: string;
  color: string;
  icon?: string | null;
}

/** What the trigger says, and what the page puts in its subtitle. */
export function scopeLabel(
  scope: WorkspaceScope,
  workspaces: readonly ScopeWorkspace[],
  t: (key: string) => string,
): string {
  if (scope === 'all') return t('All workspaces');
  if (scope === 'global') return t('Global');
  return workspaces.find((workspace) => workspace.id === scope)?.name ?? t('Workspace');
}

export function WorkspaceScopeFilter({
  value,
  onChange,
  workspaces,
  withGlobal = true,
}: {
  value: WorkspaceScope;
  onChange: (next: WorkspaceScope) => void;
  workspaces: readonly ScopeWorkspace[];
  /** Offer the global tier. False where no such tier exists — see the header. */
  withGlobal?: boolean;
}) {
  const t = useT();
  const label = scopeLabel(value, workspaces, t);
  const current = workspaces.find((workspace) => workspace.id === value);

  return (
    <Menu
      side="bottom"
      trigger={
        <Button variant="secondary" size="sm" aria-label={t('Scope: {scope}', { scope: label })}>
          {/* The chosen workspace's own colour, so the control says which one
              without being read — the reason workspaces carry a colour at all. */}
          {current ? (
            <WorkspaceAvatar color={current.color} icon={current.icon ?? null} />
          ) : (
            <Filter className="size-4" aria-hidden />
          )}
          <span className="max-w-40 truncate">{label}</span>
          <ChevronDown className="size-3.5" aria-hidden />
        </Button>
      }
    >
      <MenuLabel>{t('Scope')}</MenuLabel>
      <MenuItem
        selected={value === 'all'}
        description={t('Everything, wherever it is attached')}
        onSelect={() => onChange('all')}
      >
        {t('All workspaces')}
      </MenuItem>
      {withGlobal ? (
        <MenuItem
          selected={value === 'global'}
          description={t('Available in every workspace')}
          onSelect={() => onChange('global')}
        >
          {t('Global')}
        </MenuItem>
      ) : null}
      {workspaces.length > 0 ? <MenuSeparator /> : null}
      {workspaces.map((workspace) => (
        <MenuItem
          key={workspace.id}
          selected={value === workspace.id}
          description={withGlobal ? t('Its own definitions, plus the global ones') : undefined}
          onSelect={() => onChange(workspace.id)}
          icon={
            <WorkspaceAvatar
              color={workspace.color}
              icon={workspace.icon ?? null}
              className="mt-0.5"
            />
          }
        >
          {workspace.name}
        </MenuItem>
      ))}
    </Menu>
  );
}
