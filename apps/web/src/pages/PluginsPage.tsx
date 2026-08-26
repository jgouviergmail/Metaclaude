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

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Plug, Plus, Server, Sparkles, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { PluginRecord } from '@metaclaude/shared';
import { AppShell, ContentHeader } from '@/components/layout/AppShell';
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

export function PluginsPage() {
  const queryClient = useQueryClient();
  const [installing, setInstalling] = useState(false);
  const [source, setSource] = useState('');
  const [removing, setRemoving] = useState<PluginRecord | null>(null);

  const query = useQuery({ queryKey: ['plugins'], queryFn: () => api.plugins.list() });
  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['plugins'] });
  };

  const fail = (error: unknown, fallback: string): void => {
    toast.error(error instanceof ApiError ? error.message : fallback);
  };

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
      toast.success(`Installed ${record.name} — ${parts.join(', ')}.`);
    },
    onError: (error) => fail(error, 'That plugin could not be installed.'),
  });

  const toggle = useMutation({
    mutationFn: (plugin: PluginRecord) => api.plugins.setEnabled(plugin.id, !plugin.enabled),
    onSuccess: invalidate,
    onError: (error) => fail(error, 'That plugin could not be changed.'),
  });

  const remove = useMutation({
    mutationFn: (plugin: PluginRecord) => api.plugins.remove(plugin.id),
    onSuccess: () => {
      invalidate();
      setRemoving(null);
      toast.success('Plugin removed.');
    },
    onError: (error) => fail(error, 'That plugin could not be removed.'),
  });

  const plugins = query.data ?? [];

  return (
    <AppShell>
      <ContentHeader
        title="Plugins"
        subtitle="Agent Plugins 1.0.0 — skills and MCP servers in one package"
        actions={
          <Button variant="primary" size="sm" onClick={() => setInstalling(true)}>
            <Plus className="size-4" />
            Install
          </Button>
        }
      />

      {query.isLoading ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : plugins.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Plug />}
            title="No plugins installed"
            description="An Agent Plugin is one directory holding skills and MCP server definitions, in the format published by Amazon, Cursor, Microsoft, OpenAI and Vercel. Clone one onto this server and install it by path."
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
                    {!plugin.enabled ? <Badge tone="neutral">disabled</Badge> : null}
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
                      <span
                        key={skill.name}
                        className="inline-flex items-center gap-1.5 text-[12px] text-muted"
                        title={skill.description}
                      >
                        <Sparkles className="size-3 shrink-0 text-accent" aria-hidden />
                        <code className="font-mono">{skill.name}</code>
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
                    installed {formatRelative(plugin.installedAt)}
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
                    aria-label={`Remove plugin ${plugin.name}`}
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

      <Modal
        open={installing}
        onOpenChange={setInstalling}
        title="Install a plugin"
        description="A directory on this server holding a plugin.json, in the Agent Plugins 1.0.0 format."
      >
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="plugin-source">Path on the server</Label>
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
              The directory is copied, not linked, so the source can be deleted afterwards. Skills
              and MCP servers it declares become available to every workspace.
            </p>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setInstalling(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={!source.trim()}
              loading={install.isPending}
              onClick={() => install.mutate(source.trim())}
            >
              Install
            </Button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Remove ${removing?.name ?? 'this plugin'}?`}
        description="Its skills and MCP servers stop being offered to runs, and its files are deleted. Anything it had stored is kept, so reinstalling it restores that state."
        confirmLabel="Remove"
        danger
        onConfirm={() => {
          if (removing) remove.mutate(removing);
        }}
      />
    </AppShell>
  );
}
