/**
 * Agent Plugins.
 *
 * The list is deliberately built from the same vocabulary as Agents & skills —
 * `Card`, `Badge`, `Toggle`, `EmptyState`, the stacking action cluster — because
 * a plugin is the same kind of object to an operator: a thing that is installed,
 * switched on, and contributes skills and servers to a run.
 *
 * What a plugin adds that a skill does not is *provenance* and *partial
 * failure*. It comes from somewhere else, and the 1.0.0 specification requires
 * that a broken component does not stop the rest loading — so a plugin can be
 * installed, working, and still have something wrong with it. Warnings are
 * therefore first-class here rather than an error state that replaces the card.
 */

import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Page } from '@/components/ui/layout';
import { AlertTriangle, Plug, Plus, Server, Sparkles, Store, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { Marketplace, MarketplaceCatalogue, PluginRecord } from '@metaclaude/shared';
import { AppShell, ContentHeader } from '@/components/layout/AppShell';
import { MarketplaceList } from '@/components/registry/MarketplaceList';
import { Switch } from '@/components/ui/controls';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Label,
  Spinner,
} from '@/components/ui/primitives';
import { api, ApiError } from '@/lib/api';
import { formatRelative } from '@/lib/utils';
import { useT } from '@/lib/i18n';

export function PluginsPage() {
  const t = useT();
  const queryClient = useQueryClient();
  const [installing, setInstalling] = useState(false);
  const [source, setSource] = useState('');
  const [removing, setRemoving] = useState<PluginRecord | null>(null);
  const [addingMarketplace, setAddingMarketplace] = useState(false);
  const [removingMarketplace, setRemovingMarketplace] = useState<Marketplace | null>(null);

  const query = useQuery({ queryKey: ['plugins'], queryFn: () => api.plugins.list() });
  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['plugins'] });
  };

  const fail = (error: unknown, fallback: string): void => {
    toast.error(error instanceof ApiError ? error.message : fallback);
  };

  /* -- Marketplaces ------------------------------------------------------- */

  const marketplacesQuery = useQuery({
    queryKey: ['marketplaces'],
    queryFn: () => api.marketplaces.list(),
  });
  const marketplaces = marketplacesQuery.data?.marketplaces ?? [];

  // One catalogue query per marketplace, so a slow or broken source delays
  // only its own card.
  const catalogueQueries = useQueries({
    queries: marketplaces.map((marketplace) => ({
      queryKey: ['marketplace-catalogue', marketplace.id],
      queryFn: () => api.marketplaces.catalogue(marketplace.id),
    })),
  });
  const catalogues: Record<string, MarketplaceCatalogue | undefined> = {};
  marketplaces.forEach((marketplace, index) => {
    catalogues[marketplace.id] = catalogueQueries[index]?.data;
  });

  const invalidateMarketplaces = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['marketplaces'] });
  };

  const addMarketplace = useMutation({
    mutationFn: (input: Parameters<typeof api.marketplaces.add>[0]) => api.marketplaces.add(input),
    onSuccess: (result) => {
      invalidateMarketplaces();
      setAddingMarketplace(false);
      toast.success(t('Marketplace {name} added.', { name: result.marketplace.name }));
    },
    onError: (error) => fail(error, t('That marketplace could not be added.')),
  });

  const toggleMarketplace = useMutation({
    mutationFn: (marketplace: Marketplace) =>
      api.marketplaces.setEnabled(marketplace.id, !marketplace.enabled),
    onSuccess: invalidateMarketplaces,
    onError: (error) => fail(error, t('That marketplace could not be changed.')),
  });

  const removeMarketplace = useMutation({
    mutationFn: (marketplace: Marketplace) => api.marketplaces.remove(marketplace.id),
    onSuccess: () => {
      invalidateMarketplaces();
      setRemovingMarketplace(null);
      toast.success(t('Marketplace removed.'));
    },
    onError: (error) => fail(error, t('That marketplace could not be removed.')),
  });

  const install = useMutation({
    mutationFn: (path: string) => api.plugins.install(path),
    onSuccess: (record) => {
      invalidate();
      setInstalling(false);
      setSource('');
      const parts = [
        record.skills.length === 1 ? '1 skill' : `${record.skills.length} skills`,
        record.mcpServers.length === 1 ? '1 MCP server' : `${record.mcpServers.length} MCP servers`,
      ];
      toast.success(t(
        'Installed {name} — {parts}.',
        { name: record.name, parts: parts.join(', ') },
      ));
    },
    onError: (error) => fail(error, t('That plugin could not be installed.')),
  });

  const toggle = useMutation({
    mutationFn: (plugin: PluginRecord) => api.plugins.setEnabled(plugin.id, !plugin.enabled),
    onSuccess: invalidate,
    onError: (error) => fail(error, t('That plugin could not be changed.')),
  });

  const remove = useMutation({
    mutationFn: (plugin: PluginRecord) => api.plugins.remove(plugin.id),
    onSuccess: () => {
      invalidate();
      setRemoving(null);
      toast.success(t('Plugin removed.'));
    },
    onError: (error) => fail(error, t('That plugin could not be removed.')),
  });

  const plugins = query.data ?? [];

  return (
    <AppShell>
      <ContentHeader
        title={t('Plugins')}
        subtitle={t('Marketplaces the CLI installs from, and Agent Plugins installed by path')}
        actions={
          <Button variant="primary" size="sm" onClick={() => setInstalling(true)}>
            <Plus className="size-4" />
            {t('Install')}
          </Button>
        }
      />

      <Page width="list">
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
                <Store className="size-4 text-muted" aria-hidden />
                {t('Marketplaces')}
              </h2>
              <Button variant="secondary" size="sm" onClick={() => setAddingMarketplace(true)}>
                <Plus className="size-4" aria-hidden />
                {t('Add marketplace')}
              </Button>
        </div>
        <p className="text-[12.5px] leading-relaxed text-muted">
          {t(
            'The CLI fetches these sources itself and installs from them at the start of a run. Which plugins actually run is chosen per workspace, under Workspace settings.',
          )}
        </p>
        {marketplacesQuery.isLoading ? (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        ) : (
          <MarketplaceList
            marketplaces={marketplaces}
            catalogues={catalogues}
            onToggle={(marketplace) => toggleMarketplace.mutate(marketplace)}
            onRemove={setRemovingMarketplace}
          />
        )}
      </section>

      <h2 className="flex items-center gap-2 pt-2 text-sm font-semibold text-ink">
        <Plug className="size-4 text-muted" aria-hidden />
        {t('Installed by path')}
      </h2>

      {query.isLoading ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : plugins.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Plug />}
            title={t('No plugins installed')}
            description={t(
              'An Agent Plugin is one directory holding skills and MCP server definitions, in the format published by Amazon, Cursor, Microsoft, OpenAI and Vercel. Clone one onto this server and install it by path.',
            )}
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {plugins.map((plugin) => (
            <Card key={plugin.id} className="p-4">
              {/* Same stacking rule as Agents & skills: at 375px the action
                  cluster and the description cannot share a row. */}
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="font-mono text-[13px] font-medium text-ink">{plugin.name}</code>
                    {plugin.version ? <Badge tone="neutral">v{plugin.version}</Badge> : null}
                    {!plugin.enabled ? <Badge tone="neutral">{t('disabled')}</Badge> : null}
                    {plugin.warnings.length > 0 ? (
                      <Badge tone="warning">
                        {plugin.warnings.length === 1
                          ? '1 warning'
                          : `${plugin.warnings.length} warnings`}
                      </Badge>
                    ) : null}
                  </div>

                  {plugin.description ? (
                    <p className="text-[13px] leading-relaxed text-muted">{plugin.description}</p>
                  ) : null}

                  {/* What it actually contributes. A plugin whose contents are
                      invisible is indistinguishable from one that does nothing. */}
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-0.5">
                    {plugin.skills.map((skill) => (
                      // The description was a `title`, so on a phone a skill
                      // was a bare name with no way to learn what it does.
                      // Rendered after the name, dimmed, and truncated by the
                      // row rather than hidden by it.
                      <span
                        key={skill.name}
                        className="inline-flex min-w-0 items-center gap-1.5 text-[12px] text-muted"
                      >
                        <Sparkles className="size-3 shrink-0 text-accent" aria-hidden />
                        <code className="shrink-0 font-mono">{skill.name}</code>
                        {skill.description ? (
                          <span className="truncate text-subtle">{skill.description}</span>
                        ) : null}
                      </span>
                    ))}
                    {plugin.mcpServers.map((name) => (
                      <span
                        key={name}
                        className="inline-flex items-center gap-1.5 text-[12px] text-muted"
                      >
                        <Server className="size-3 shrink-0 text-info" aria-hidden />
                        <code className="font-mono">{name}</code>
                      </span>
                    ))}
                  </div>

                  <p className="text-[11.5px] tabular-nums text-subtle">
                    {t('installed')} {formatRelative(plugin.installedAt)}
                    {plugin.license ? ` · ${plugin.license}` : ''}
                  </p>

                  {plugin.warnings.length > 0 ? (
                    <ul className="space-y-1 rounded-lg bg-warning-soft px-3 py-2">
                      {plugin.warnings.map((warning) => (
                        <li key={warning} className="flex gap-2 text-[12px] leading-relaxed text-ink">
                          <AlertTriangle
                            className="mt-0.5 size-3 shrink-0 text-warning"
                            aria-hidden
                          />
                          <span>{warning}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>

                <div className="flex items-center gap-2 sm:shrink-0">
                  <Switch
                    checked={plugin.enabled}
                    onChange={() => toggle.mutate(plugin)}
                    label={`${plugin.enabled ? 'Disable' : 'Enable'} plugin ${plugin.name}`}
                  />
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('Remove plugin {name}', { name: plugin.name })}
                    onClick={() => setRemoving(plugin)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      </Page>

      <Modal
        open={installing}
        onOpenChange={setInstalling}
        title={t('Install a plugin')}
        description={t(
          'A directory on this server holding a plugin.json, in the Agent Plugins 1.0.0 format.',
        )}
      >
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="plugin-source">{t('Path on the server')}</Label>
            <Input
              id="plugin-source"
              autoComplete="off"
              spellCheck={false}
              placeholder="/srv/metaclaude/workspaces/tools/my-plugin"
              value={source}
              onChange={(event) => setSource(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && source.trim()) install.mutate(source.trim());
              }}
            />
            <p className="text-[12px] text-muted">
              {t(
                'The directory is copied, not linked, so the source can be deleted afterwards. Skills and MCP servers it declares become available to every workspace.',
              )}
            </p>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setInstalling(false)}>
              {t('Cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={!source.trim()}
              loading={install.isPending}
              onClick={() => install.mutate(source.trim())}
            >
              {t('Install')}
            </Button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={t('Remove {name}?', { name: removing?.name ?? t('this plugin') })}
        description={t(
          'Its skills and MCP servers stop being offered to runs, and its files are deleted. Anything it had stored is kept, so reinstalling it restores that state.',
        )}
        confirmLabel={t('Remove')}
        danger
        onConfirm={() => {
          if (removing) remove.mutate(removing);
        }}
      />

      <AddMarketplaceModal
        open={addingMarketplace}
        onOpenChange={setAddingMarketplace}
        onAdd={(input) => addMarketplace.mutate(input)}
        pending={addMarketplace.isPending}
      />

      <ConfirmDialog
        open={removingMarketplace !== null}
        onOpenChange={(open) => !open && setRemovingMarketplace(null)}
        title={t('Remove {name}?', { name: removingMarketplace?.name ?? t('this marketplace') })}
        description={t(
          'Runs stop seeing this source, and every plugin enabled from it stops loading. Nothing already installed by the CLI is deleted.',
        )}
        confirmLabel={t('Remove')}
        danger
        onConfirm={() => {
          if (removingMarketplace) removeMarketplace.mutate(removingMarketplace);
        }}
      />
    </AppShell>
  );
}

/**
 * One field for the source, not a kind selector: an `https://` value is a
 * marketplace.json URL and anything else is `owner/repo`. The distinction is
 * mechanical, so the form makes it rather than asking.
 */
function AddMarketplaceModal({
  open,
  onOpenChange,
  onAdd,
  pending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (input: { name: string; source: Marketplace['source'] }) => void;
  pending: boolean;
}) {
  const t = useT();
  const [name, setName] = useState('');
  const [source, setSource] = useState('');

  const submit = (): void => {
    const trimmed = source.trim();
    onAdd({
      name: name.trim(),
      source: trimmed.startsWith('https://')
        ? { source: 'url', url: trimmed }
        : { source: 'github', repo: trimmed },
    });
  };
  const ready = name.trim().length > 0 && source.trim().length > 0;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t('Add a marketplace')}
      description={t(
        'Plugins from it bring skills, hooks and MCP servers into the agent — add sources you trust as you would a dependency.',
      )}
    >
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="marketplace-name">{t('Name')}</Label>
          <Input
            id="marketplace-name"
            autoComplete="off"
            spellCheck={false}
            placeholder="anthropic-tools"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <p className="text-[12px] text-muted">
            {t(
              'Plugins are enabled as',
            )} <code className="font-mono">plugin@{name.trim() || 'name'}</code>.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="marketplace-source">{t('Source')}</Label>
          <Input
            id="marketplace-source"
            autoComplete="off"
            spellCheck={false}
            placeholder={t('owner/repo, or https://…/marketplace.json')}
            value={source}
            onChange={(event) => setSource(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && ready) submit();
            }}
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t('Cancel')}
          </Button>
          <Button variant="primary" size="sm" disabled={!ready} loading={pending} onClick={submit}>
            {t('Add')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
