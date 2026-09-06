/**
 * The plugin marketplaces — sources the CLI itself installs from.
 *
 * Prop-driven; the page owns the queries and mutations. Each card shows the
 * source, the enable switch, and the catalogue as the marketplace's own
 * `marketplace.json` describes it. A catalogue that failed to load renders
 * its error verbatim: a broken source that shows nothing would be
 * indistinguishable from an empty one.
 */

import { AlertTriangle, Package, Store, Trash2 } from 'lucide-react';
import type { Marketplace, MarketplaceCatalogue } from '@metaclaude/shared';
import { Switch } from '@/components/ui/controls';
import { Badge, Button, Card, EmptyState, Spinner } from '@/components/ui/primitives';
import { useT } from '@/lib/i18n';

function sourceLabel(marketplace: Marketplace): string {
  return marketplace.source.source === 'github' ? marketplace.source.repo : marketplace.source.url;
}

export function MarketplaceList({
  marketplaces,
  catalogues,
  onToggle,
  onRemove,
}: {
  marketplaces: Marketplace[];
  /** Catalogues by marketplace id; absence means the fetch is still running. */
  catalogues: Record<string, MarketplaceCatalogue | undefined>;
  onToggle: (marketplace: Marketplace) => void;
  onRemove: (marketplace: Marketplace) => void;
}) {
  const t = useT();
  if (marketplaces.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<Store />}
          title={t('No marketplaces yet')}
          description={t(
            'A marketplace is a repository of plugins the Claude CLI installs from directly — add one by its GitHub repo or its marketplace.json URL.',
          )}
        />
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {marketplaces.map((marketplace) => {
        const catalogue = catalogues[marketplace.id];
        return (
          <Card key={marketplace.id} className="p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="font-mono text-body font-medium text-ink">
                    {marketplace.name}
                  </code>
                  {!marketplace.enabled ? <Badge tone="neutral">{t('disabled')}</Badge> : null}
                </div>
                <p className="truncate font-mono text-caption text-muted">
                  {sourceLabel(marketplace)}
                </p>

                {catalogue === undefined ? (
                  <Spinner className="size-4" />
                ) : catalogue.error ? (
                  <p className="flex gap-2 rounded-lg bg-warning-soft px-3 py-2 text-caption leading-relaxed text-ink">
                    <AlertTriangle className="mt-0.5 size-3 shrink-0 text-warning" aria-hidden />
                    <span>{catalogue.error}</span>
                  </p>
                ) : (
                  <ul className="space-y-1 pt-0.5">
                    {catalogue.plugins.map((plugin) => (
                      <li
                        key={plugin.name}
                        className="flex flex-wrap items-baseline gap-x-2 text-caption"
                      >
                        <span className="inline-flex items-center gap-1.5">
                          <Package className="size-3 shrink-0 text-accent" aria-hidden />
                          <code className="font-mono text-ink">{plugin.name}</code>
                        </span>
                        {plugin.version ? (
                          <span className="tabular-nums text-subtle">v{plugin.version}</span>
                        ) : null}
                        {plugin.description ? (
                          <span className="text-muted">{plugin.description}</span>
                        ) : null}
                      </li>
                    ))}
                    {catalogue.plugins.length === 0 ? (
                      <li className="text-caption text-subtle">{t(
                        'This marketplace lists no plugins.',
                      )}</li>
                    ) : null}
                  </ul>
                )}
              </div>

              <div className="flex items-center gap-2 sm:shrink-0">
                <Switch
                  checked={marketplace.enabled}
                  onChange={() => onToggle(marketplace)}
                  label={`${marketplace.enabled ? 'Disable' : 'Enable'} marketplace ${marketplace.name}`}
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('Remove marketplace {name}', { name: marketplace.name })}
                  onClick={() => onRemove(marketplace)}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
