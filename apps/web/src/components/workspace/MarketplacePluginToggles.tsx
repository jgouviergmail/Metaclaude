/**
 * Which marketplace plugins run in this workspace.
 *
 * Prop-driven; the settings modal owns the state. An entry that is enabled
 * but whose marketplace is gone stays listed and marked: the supervisor
 * drops it from runs silently, and this row is the only place that says why
 * the plugin stopped working — and the only way to switch it off.
 */

import type { ReactNode } from 'react';
import { Switch } from '@/components/ui/controls';
import { Badge } from '@/components/ui/primitives';
import { useT } from '@/lib/i18n';

export function MarketplacePluginToggles({
  available,
  enabled,
  onChange,
}: {
  /** Plugins the enabled marketplaces offer, keyed `plugin@marketplace`. */
  available: Array<{ key: string; description: string | null }>;
  enabled: Record<string, boolean>;
  onChange: (key: string, on: boolean) => void;
}) {
  const t = useT();
  const availableKeys = new Set(available.map((plugin) => plugin.key));
  const orphans = Object.entries(enabled).filter(([key, on]) => on && !availableKeys.has(key));

  if (available.length === 0 && orphans.length === 0) {
    return (
      <p className="text-caption text-muted">
        {t('No marketplace offers plugins yet — add one under Plugins.')}
      </p>
    );
  }

  const row = (key: string, on: boolean, detail: ReactNode): ReactNode => (
    <li key={key} className="flex items-center gap-3 py-1.5">
      <div className="min-w-0 flex-1">
        <code className="font-mono text-caption text-ink">{key}</code>
        {detail}
      </div>
      <Switch
        checked={on}
        onChange={() => onChange(key, !on)}
        label={`${on ? 'Disable' : 'Enable'} ${key} in this workspace`}
      />
    </li>
  );

  return (
    <ul className="divide-y divide-line">
      {available.map((plugin) =>
        row(
          plugin.key,
          enabled[plugin.key] === true,
          plugin.description ? (
            <p className="truncate text-caption text-muted">{plugin.description}</p>
          ) : null,
        ),
      )}
      {orphans.map(([key]) =>
        row(
          key,
          true,
          <p className="text-caption text-warning">
            <Badge tone="warning" className="mr-1.5">
              {t('source missing')}
            </Badge>
            {t('Its marketplace is disabled or removed, so runs no longer load it.')}
          </p>,
        ),
      )}
    </ul>
  );
}
