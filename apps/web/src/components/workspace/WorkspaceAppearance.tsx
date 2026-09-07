/**
 * How a workspace looks: its colour, and its icon.
 *
 * Two controls in one file because they answer one question and now have two
 * callers each — the creation dialog and the settings dialog. The colour row
 * existed only in creation, so a workspace's colour was chosen once and never
 * again; the icon was worse, a field the schema stored and the PATCH route
 * accepted that no control ever set and no screen ever showed.
 *
 * Both are `fieldset`/`legend` and both use `aria-pressed`, because a swatch
 * is a toggle in a group rather than a link: a screen reader has to be able to
 * hear which one is current, and colour alone cannot say it.
 */

import { X } from 'lucide-react';
import { WorkspaceAvatar } from '@/components/workspace/WorkspaceAvatar';
import { TOUCH_TARGET_Y } from '@/components/ui/touch-target';
import { useT } from '@/lib/i18n';
import { cn, WORKSPACE_COLORS } from '@/lib/utils';
import { WORKSPACE_ICON_NAMES, workspaceIcon } from '@/lib/workspace-icons';

export function ColourPicker({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  const t = useT();

  return (
    <fieldset>
      <legend className="mb-1.5 text-body font-medium text-ink">{t('Colour')}</legend>
      <div className="flex flex-wrap gap-2">
        {WORKSPACE_COLORS.map((swatch) => (
          <button
            key={swatch}
            type="button"
            disabled={disabled}
            onClick={() => onChange(swatch)}
            aria-label={t('Use colour {swatch}', { swatch: swatch })}
            aria-pressed={value === swatch}
            className={cn(
              'size-7 rounded-lg ring-offset-2 ring-offset-surface transition-all',
              'data-[active=true]:ring-2 data-[active=true]:ring-accent',
              'disabled:cursor-not-allowed disabled:opacity-50',
              TOUCH_TARGET_Y,
            )}
            data-active={value === swatch}
            style={{ background: swatch }}
          />
        ))}
      </div>
    </fieldset>
  );
}

export function IconPicker({
  value,
  color,
  onChange,
  disabled,
}: {
  /** The stored name, or '' for none. */
  value: string;
  /** The workspace's colour, so each choice is previewed as it will look. */
  color: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  const t = useT();

  return (
    <fieldset>
      <legend className="mb-1.5 text-body font-medium text-ink">{t('Icon')}</legend>
      <div className="flex flex-wrap gap-2">
        {/*
          Removing the icon is a choice of its own, first in the row and
          shaped like the others. Without it an operator who picked one could
          never go back to the plain square — which is what every workspace
          looked like before this existed, and still the default.
        */}
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange('')}
          aria-label={t('No icon')}
          aria-pressed={value === ''}
          className={cn(
            'flex size-9 items-center justify-center rounded-lg border border-line text-muted',
            'ring-offset-2 ring-offset-surface transition-all hover:text-ink',
            'data-[active=true]:ring-2 data-[active=true]:ring-accent',
            'disabled:cursor-not-allowed disabled:opacity-50',
            TOUCH_TARGET_Y,
          )}
          data-active={value === ''}
        >
          <X className="size-4" aria-hidden />
        </button>

        {WORKSPACE_ICON_NAMES.map((name) => {
          const Glyph = workspaceIcon(name);
          if (!Glyph) return null;
          return (
            <button
              key={name}
              type="button"
              disabled={disabled}
              onClick={() => onChange(name)}
              // The stored name, which is what an operator would search for and
              // what the audit log will show. Translating it would name the
              // control something the database has never heard of.
              aria-label={name}
              aria-pressed={value === name}
              className={cn(
                'flex size-9 items-center justify-center rounded-lg ring-offset-2',
                'ring-offset-surface transition-all',
                'data-[active=true]:ring-2 data-[active=true]:ring-accent',
                'disabled:cursor-not-allowed disabled:opacity-50',
                TOUCH_TARGET_Y,
              )}
              data-active={value === name}
            >
              {/* Previewed on the workspace's own colour, because that is the
                  only place it will ever be seen. A glyph that reads on the
                  page and vanishes on the square would be a picker that lies. */}
              <WorkspaceAvatar color={color} icon={name} size="md" />
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
