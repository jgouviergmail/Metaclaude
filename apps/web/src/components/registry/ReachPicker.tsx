/**
 * Which workspaces an extension reaches.
 *
 * One control for skills, subagents and MCP servers, for the reason
 * `AvailabilityFilter` is one control: the three editors ask an identical
 * question about different rows, and three copies of a reach picker is how one
 * of them ends up unable to express "nowhere".
 *
 * Two states, and both are said out loud. **Global** means every workspace,
 * including any created later — the semantics the old nullable column carried,
 * kept because losing it would make every new workspace start bare. Otherwise
 * the reach is the boxes ticked, and ticking none is a real answer: the
 * extension stays in the library and is mounted nowhere. The old single column
 * could not say that at all, which is why an extension useful to three
 * projects out of eight had to be either global or written three times.
 *
 * The count rides on the summary line rather than only inside the list,
 * because the list is the long part and the number is the answer.
 */

import { Globe } from 'lucide-react';
import type { ExtensionReach } from '@metaclaude/shared';
import { CheckboxField } from '@/components/ui/controls';
import { Button } from '@/components/ui/primitives';
import { usePlural, useT } from '@/lib/i18n';
import { WorkspaceAvatar } from '@/components/workspace/WorkspaceAvatar';

export function ReachPicker({
  value,
  workspaces,
  onChange,
  disabled = false,
}: {
  value: ExtensionReach;
  workspaces: readonly { id: string; name: string; color: string; icon?: string }[];
  onChange: (next: ExtensionReach) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const plural = usePlural();

  const ticked = new Set(value.workspaceIds);
  const toggle = (id: string, on: boolean) =>
    onChange({
      // Belt and braces, and unreachable today: the list below only renders
      // while the reach is not global, so no box here can be ticked from that
      // state. Kept because it states the invariant at the point that would
      // break it — and named as unreachable, because no test can discriminate
      // it and one claiming to would be a test that proves nothing.
      global: false,
      workspaceIds: on
        ? [...value.workspaceIds, id]
        : value.workspaceIds.filter((one) => one !== id),
    });

  return (
    <fieldset className="space-y-3">
      <legend className="text-body font-medium text-ink">{t('Available in')}</legend>

      <CheckboxField
        checked={value.global}
        disabled={disabled}
        onChange={(on) => onChange({ global: on, workspaceIds: on ? [] : value.workspaceIds })}
        label={
          <span className="inline-flex items-center gap-1.5">
            <Globe className="size-3.5" aria-hidden />
            {t('Every workspace')}
          </span>
        }
        hint={t('Including any created later. Untick to choose them one by one.')}
      />

      {value.global ? null : (
        <div className="space-y-2 rounded-lg border border-line bg-sunken/40 p-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-caption text-muted">
              {value.workspaceIds.length === 0
                ? /* Said plainly. An extension reaching nothing is a state an
                     operator can choose, and one they can also reach by
                     accident — so the screen names it rather than showing an
                     empty tick list and leaving them to work it out. */
                  t('No workspace — it stays in the library and runs nowhere.')
                : plural(
                    value.workspaceIds.length,
                    '{n} workspace',
                    '{n} workspaces',
                  )}
            </span>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={disabled || value.workspaceIds.length === workspaces.length}
                onClick={() =>
                  onChange({ global: false, workspaceIds: workspaces.map((one) => one.id) })
                }
              >
                {t('Tick all')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={disabled || value.workspaceIds.length === 0}
                onClick={() => onChange({ global: false, workspaceIds: [] })}
              >
                {t('Untick all')}
              </Button>
            </div>
          </div>

          {workspaces.map((workspace) => (
            <CheckboxField
              key={workspace.id}
              checked={ticked.has(workspace.id)}
              disabled={disabled}
              onChange={(on) => toggle(workspace.id, on)}
              label={
                <span className="inline-flex items-center gap-2">
                  <WorkspaceAvatar color={workspace.color} icon={workspace.icon} />
                  {workspace.name}
                </span>
              }
            />
          ))}
        </div>
      )}
    </fieldset>
  );
}
