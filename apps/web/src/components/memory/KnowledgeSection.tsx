/**
 * The knowledge library — the operator-facing half of the document RAG.
 *
 * Lives on the Memory page because the two are the system's two kinds of
 * recall: what it learned (memories, above) and what it was given to read
 * (documents, here). The section makes the three decisions visible that make
 * a library trustworthy:
 *
 *  - **Scope is worn, not implied** — every card carries Global or its
 *    workspace's name, the same vocabulary the whole app uses.
 *  - **A document can be paused** without being destroyed: the switch removes
 *    it from retrieval while the text stays editable.
 *  - **Retrieval can be rehearsed.** The preview search runs the exact
 *    pipeline a run uses — same arms, same gates, same diversity cap — so
 *    "what would the agent see?" is answered by showing it, passages, scores
 *    and sources included.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpenCheck, FileText, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type { KnowledgeDocumentMeta, Workspace } from '@metaclaude/shared';

import { ScopeBadge } from '@/components/memory/ScopeBadge';
import { Switch } from '@/components/ui/controls';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Label,
  Select,
  Skeleton,
  Textarea,
  Tooltip,
} from '@/components/ui/primitives';
import { api, ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { formatBytes, formatRelative } from '@/lib/utils';

interface Draft {
  id?: string;
  title: string;
  content: string;
  workspaceId: string | null;
  enabled: boolean;
}

const EMPTY_DRAFT: Draft = { title: '', content: '', workspaceId: null, enabled: true };

/**
 * Pending either way: written without a model (`''`), or under a provider that
 * is no longer the live one. Both are rebuilt by the same pass; both deserve the
 * same badge.
 */
const pendingVectorsFor = (embedder: string | undefined) => (doc: KnowledgeDocumentMeta): boolean =>
  doc.embeddingModel === '' || (embedder !== undefined && doc.embeddingModel !== embedder);

export function KnowledgeSection({
  scope,
  workspaces, embedder }: {
  /** `all` | `global` | a workspace id — the Memory page's own scope. */
  scope: string;
  workspaces: Workspace[]; 
  /** The embedder in force, from the health endpoint; a document under any other id is waiting for a rebuild. */
  embedder?: string;
}) {
  const pendingVectors = pendingVectorsFor(embedder);
  const t = useT();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<KnowledgeDocumentMeta | null>(null);
  const [probe, setProbe] = useState('');
  const [probeQuery, setProbeQuery] = useState('');

  const listOptions =
    scope === 'global'
      ? { scope: 'global' as const }
      : scope !== 'all'
        ? { workspaceId: scope }
        : undefined;

  const query = useQuery({
    queryKey: ['knowledge', scope],
    queryFn: () => api.knowledge.list(listOptions),
  });

  const preview = useQuery({
    queryKey: ['knowledge-preview', probeQuery, scope],
    queryFn: () => api.knowledge.search(probeQuery, scope === 'all' || scope === 'global' ? undefined : scope),
    enabled: probeQuery.trim().length > 0,
  });

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['knowledge'] });

  const save = useMutation({
    mutationFn: (draft: Draft) =>
      api.knowledge.save({
        ...(draft.id ? { id: draft.id } : {}),
        title: draft.title.trim(),
        content: draft.content,
        workspaceId: draft.workspaceId,
        enabled: draft.enabled,
      }),
    onSuccess: (result) => {
      refresh();
      setEditing(null);
      toast.success(t('Saved “{name}”', { name: result.document.title }), {
        description:
          result.document.embeddingModel === ''
            ? t('{n} passages indexed; their vectors are being computed in the background.', {
                n: String(result.document.chunkCount),
              })
            : t('{n} passages indexed and ready to be retrieved.', {
                n: String(result.document.chunkCount),
              }),
      });
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('Could not save that document.')),
  });

  const toggle = useMutation({
    // Flipping the switch re-saves with the same content; the store's hash
    // makes that a metadata write, never a re-embed.
    mutationFn: async (meta: KnowledgeDocumentMeta) => {
      const { document } = await api.knowledge.get(meta.id);
      return api.knowledge.save({
        id: meta.id,
        title: document.title,
        content: document.content,
        workspaceId: document.workspaceId,
        enabled: !meta.enabled,
      });
    },
    onSuccess: refresh,
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t(
        'Could not update that document.',
      )),
  });

  // The twin of memory's re-index: after switching embedding provider the
  // dense arm silently stops contributing until every passage is re-embedded,
  // and the lexical arm keeps answering — quiet enough to need a button.
  const reindex = useMutation({
    mutationFn: () => api.knowledge.reindex(),
    onSuccess: (result) => {
      refresh();
      toast.success(
        result.affected === 0
          ? t('Everything was already indexed with the current embedder.')
          : result.affected === 1
            ? t('1 passage re-embedded.')
            : t('{n} passages re-embedded.', { n: String(result.affected) }),
      );
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('Could not re-index.')),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.knowledge.delete(id),
    onSuccess: () => {
      refresh();
      toast.success(t('Document deleted'), {
        description: t('Its passages left the index with it.'),
      });
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t(
        'Could not delete that document.',
      )),
  });

  const openFor = async (meta: KnowledgeDocumentMeta) => {
    try {
      const { document } = await api.knowledge.get(meta.id);
      setEditing({
        id: document.id,
        title: document.title,
        content: document.content,
        workspaceId: document.workspaceId,
        enabled: document.enabled,
      });
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : t('Could not open that document.'));
    }
  };

  const documents = query.data?.documents ?? [];

  return (
    <section className="space-y-4" aria-labelledby="knowledge-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="space-y-1">
          <h2 id="knowledge-heading" className="flex items-center gap-2 text-title font-semibold text-ink">
            <BookOpenCheck className="size-4 text-accent" aria-hidden />
            {t('Knowledge library')}
          </h2>
          <p className="max-w-2xl text-body leading-relaxed text-muted">
            {t(
              'Reference documents the agent can quote — a lease, a spec, a runbook. Global documents reach every workspace; scoped ones stay in theirs. Runs retrieve the relevant passages automatically, and the transcript shows which ones were used.',
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {documents.length > 0 ? (
            // The app's Tooltip, not a `title` attribute: the native one is
            // unstyled, sits outside the charter, and never appears on touch —
            // where this screen is used as much as on a desktop.
            <Tooltip content={t(
              'Recompute every passage’s embedding — needed after changing embedding provider.',
            )}>
              <Button
                variant="ghost"
                size="sm"
                loading={reindex.isPending}
                onClick={() => reindex.mutate()}
              >
                <RefreshCw className="size-4" />
                {t('Re-index')}
              </Button>
            </Tooltip>
          ) : null}
          <Button variant="primary" size="sm" onClick={() => setEditing({ ...EMPTY_DRAFT, workspaceId: scope !== 'all' && scope !== 'global' ? scope : null })}>
            <Plus className="size-4" />
            {t('Add document')}
          </Button>
        </div>
      </div>

      {query.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      ) : documents.length === 0 ? (
        <Card>
          <EmptyState
            icon={<FileText />}
            title={t('Nothing on the shelf yet')}
            description={t(
              'Paste the documents your runs keep needing — the contract, the conventions, the runbook — and the agent will cite them instead of guessing.',
            )}
          />
        </Card>
      ) : (
        <div className="space-y-2">
          {documents.map((doc) => (
            <Card key={doc.id} className="p-3.5">
              <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void openFor(doc)}
                      className="truncate text-left text-body font-medium text-ink transition-colors hover:text-accent"
                    >
                      {doc.title}
                    </button>
                    <ScopeBadge workspaceId={doc.workspaceId} workspaces={workspaces} />
                    {!doc.enabled ? <Badge tone="warning">{t('Paused')}</Badge> : null}
                    {pendingVectors(doc) ? (
                      <Tooltip content={t('Findable by its words already; its vectors are being computed in the background.')}>
                        <span className="inline-flex"><Badge tone="thinking">{t('Vectors pending')}</Badge></span>
                      </Tooltip>
                    ) : null}
                  </div>
                  <p className="text-caption text-subtle">
                    {t(
                      '{n} passages',
                      { n: String(doc.chunkCount) },
                    )} · {formatBytes(doc.contentLength)} ·{' '}
                    {formatRelative(doc.updatedAt)}
                  </p>
                </div>

                <div className="flex items-center gap-2 sm:shrink-0">
                  <Switch
                    checked={doc.enabled}
                    onChange={() => toggle.mutate(doc)}
                    label={t('Retrieve from “{name}”', { name: doc.title })}
                    tooltip={
                      doc.enabled
                        ? t(
                          'On: runs can retrieve these passages. Switch off to pause without deleting.',
                        )
                        : t('Paused: kept and editable, but never retrieved.')
                    }
                  />
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('Delete “{name}”', { name: doc.title })}
                    onClick={() => setDeleting(doc)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {documents.length > 0 ? (
        <Card className="space-y-3 p-4">
          <div className="space-y-1">
            <h3 className="flex items-center gap-2 text-body font-semibold text-ink">
              <Search className="size-3.5 text-accent" aria-hidden />
              {t('Rehearse a retrieval')}
            </h3>
            <p className="text-caption leading-relaxed text-muted">
              {t(
                'Ask what a run would ask, and see exactly the passages it would be shown — same search, same gates, scores included.',
              )}
            </p>
          </div>
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              setProbeQuery(probe);
            }}
          >
            <Input
              value={probe}
              onChange={(event) => setProbe(event.target.value)}
              placeholder={t('e.g. what is the notice period?')}
              aria-label={t('Rehearse a retrieval')}
            />
            <Button type="submit" variant="secondary" size="sm" disabled={!probe.trim()}>
              {t('Preview')}
            </Button>
          </form>

          {probeQuery ? (
            preview.isLoading ? (
              <Skeleton className="h-12" />
            ) : (preview.data?.results.length ?? 0) === 0 ? (
              <p className="text-caption text-subtle">
                {t('Nothing relevant enough — a run would receive no passages for this.')}
              </p>
            ) : (
              <ul className="space-y-2">
                {preview.data!.results.map((hit) => (
                  <li key={hit.chunkId} className="rounded-lg border border-line bg-sunken/40 p-3">
                    <p className="text-caption font-medium text-accent">
                      {[hit.documentTitle, hit.heading].filter(Boolean).join(' › ')}
                      <span className="ml-2 font-mono text-caption text-subtle">
                        {hit.score.toFixed(3)}
                      </span>
                    </p>
                    <p className="mt-1 line-clamp-3 text-caption leading-relaxed text-muted">
                      {hit.text}
                    </p>
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </Card>
      ) : null}

      <Modal
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        title={editing?.id ? t('Edit document') : t('Add a document')}
      >
        {editing ? (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              save.mutate(editing);
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="knowledge-title">{t('Title')}</Label>
              <Input
                id="knowledge-title"
                value={editing.title}
                onChange={(event) => setEditing({ ...editing, title: event.target.value })}
                placeholder={t('e.g. Lease — 12 rue des Lilas')}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="knowledge-scope">{t('Scope')}</Label>
              <Select
                id="knowledge-scope"
                value={editing.workspaceId ?? ''}
                onChange={(event) =>
                  setEditing({ ...editing, workspaceId: event.target.value || null })
                }
              >
                <option value="">{t('Global — every workspace')}</option>
                {workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </option>
                ))}
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="knowledge-content">{t('Content')}</Label>
              <Textarea
                id="knowledge-content"
                rows={12}
                value={editing.content}
                onChange={(event) => setEditing({ ...editing, content: event.target.value })}
                placeholder={t(
                  'Paste the text. Markdown headings become the sections passages are cited under.',
                )}
              />
            </div>

            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(null)}>
                {t('Cancel')}
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                loading={save.isPending}
                disabled={!editing.title.trim() || !editing.content.trim() || save.isPending}
              >
                {editing.id ? t('Save document') : t('Add to the library')}
              </Button>
            </div>
          </form>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={t('Delete this document?')}
        description={
          <>
            <span className="font-medium text-ink">{deleting?.title}</span>{' '}
            {t('and every passage indexed from it are removed. Runs stop seeing it immediately.')}
          </>
        }
        confirmLabel={t('Delete document')}
        danger
        onConfirm={async () => {
          if (deleting) await remove.mutateAsync(deleting.id);
          setDeleting(null);
        }}
      />
    </section>
  );
}
