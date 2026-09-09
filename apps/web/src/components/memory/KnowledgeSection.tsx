/**
 * The knowledge library — the operator-facing half of the document RAG.
 *
 * Lives on the Memory page because the two are the system's two kinds of
 * recall: what it learned (memories, above) and what it was given to read
 * (documents, here). The section makes four decisions visible:
 *
 *  - **Reach is worn, not implied** — every card says Global, the workspaces
 *    it is attached to, or "no workspace", in the vocabulary the registry
 *    screens already use.
 *  - **A document can be paused** without being destroyed: the switch removes
 *    it from retrieval while the text stays.
 *  - **A file keeps its original.** It can be downloaded, and read again when
 *    an extractor improves — so a document is never stuck with the engine
 *    that happened to be installed the day it arrived.
 *  - **Retrieval can be rehearsed.** The preview runs the exact pipeline a run
 *    uses — same arms, same gates, same diversity cap — so "what would the
 *    agent see?" is answered by showing it, with each passage's page and lines.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BookOpenCheck,
  Download,
  Eye,
  FileText,
  MoreVertical,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import type { ExtensionReach, KnowledgeDocumentMeta, Workspace } from '@metaclaude/shared';

import { KnowledgeUploadZone } from '@/components/memory/KnowledgeUploadZone';
import { KnowledgeViewer } from '@/components/memory/KnowledgeViewer';
import { ReachBadge } from '@/components/registry/ReachBadge';
import { ReachPicker } from '@/components/registry/ReachPicker';
import type { WorkspaceScope } from '@/components/registry/WorkspaceScopeFilter';
import { Switch } from '@/components/ui/controls';
import { Menu, MenuItem } from '@/components/ui/Menu';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Label,
  Skeleton,
  Textarea,
  Tooltip,
} from '@/components/ui/primitives';
import { FILTER_ROW, Section } from '@/components/ui/layout';
import { api, ApiError } from '@/lib/api';
import { usePlural, useT } from '@/lib/i18n';
import { formatLabel, formatLocation, matchesTitle } from '@/lib/knowledge';
import { cn, formatBytes, formatRelative } from '@/lib/utils';

interface Draft {
  id?: string;
  title: string;
  /** Empty for a file-backed document: its text is not editable here. */
  content: string;
  reach: ExtensionReach;
  enabled: boolean;
  /** Set when this document came from a file, so the form hides the textarea. */
  fromFile: boolean;
}

const GLOBAL_REACH: ExtensionReach = { global: true, workspaceIds: [] };

/**
 * Pending either way: written without a model (`''`), or under a provider that
 * is no longer the live one. Both are rebuilt by the same pass; both deserve the
 * same badge.
 */
const pendingVectorsFor =
  (embedder: string | undefined) =>
  (doc: KnowledgeDocumentMeta): boolean =>
    doc.embeddingModel === '' || (embedder !== undefined && doc.embeddingModel !== embedder);

/** What a document dropped while this scope is showing should reach. */
const reachForScope = (scope: WorkspaceScope): ExtensionReach =>
  scope === 'all' || scope === 'global'
    ? GLOBAL_REACH
    : { global: false, workspaceIds: [scope] };

export function KnowledgeSection({
  scope,
  openDocument,
  onViewerClosed,
  workspaces,
  embedder,
}: {
  /**
   * Which workspaces to show, from the page's own filter.
   *
   * The page owns it, and that is the point: an operator narrowing the screen
   * to one project means both halves of it — what that project learned and
   * what it was given to read. A second control here would be the same
   * question asked twice, in two places, with two answers.
   */
  scope: WorkspaceScope;
  /** A document to open on arrival, and the line to open it at. */
  openDocument?: { id: string; line: number | null } | null;
  onViewerClosed?: () => void;
  workspaces: Workspace[];
  /** The embedder in force, from the health endpoint; a document under any other id is waiting for a rebuild. */
  embedder?: string;
}) {
  const pendingVectors = pendingVectorsFor(embedder);
  const t = useT();
  const plural = usePlural();
  const queryClient = useQueryClient();

  const [titleQuery, setTitleQuery] = useState('');
  const [editing, setEditing] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<KnowledgeDocumentMeta | null>(null);
  const [viewing, setViewing] = useState<{ id: string; line: number | null } | null>(
    openDocument ?? null,
  );
  const [probe, setProbe] = useState('');
  const [probeQuery, setProbeQuery] = useState('');

  const listOptions =
    scope === 'global'
      ? { scope: 'global' as const }
      : scope !== 'all'
        ? { workspaceId: scope }
        : undefined;

  const query = useQuery({
    queryKey: ['knowledge', 'list', scope],
    queryFn: () => api.knowledge.list(listOptions),
  });

  const preview = useQuery({
    queryKey: ['knowledge', 'preview', probeQuery, scope],
    queryFn: () =>
      api.knowledge.search(probeQuery, scope === 'all' || scope === 'global' ? undefined : scope),
    enabled: probeQuery.trim().length > 0,
  });

  /**
   * Everything the library caches, under one prefix.
   *
   * The viewer's document was keyed `['knowledge-document', id]`, which
   * `['knowledge']` does *not* match — React Query compares element by
   * element. So a re-extraction refreshed the list and left the viewer holding
   * the old text for the fifteen seconds a query stays fresh, with the old
   * line numbers on it: exactly what the provenance work exists to prevent,
   * on the one screen built to check a citation.
   */
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['knowledge'] });

  const save = useMutation({
    mutationFn: (draft: Draft) =>
      draft.fromFile
        ? // A file's text is not editable, so a save of one is a patch.
          api.knowledge.patch(draft.id!, {
            title: draft.title.trim(),
            enabled: draft.enabled,
            reach: draft.reach,
          })
        : api.knowledge.save({
            ...(draft.id ? { id: draft.id } : {}),
            title: draft.title.trim(),
            content: draft.content,
            workspaceId: null,
            enabled: draft.enabled,
            reach: draft.reach,
          }),
    onSuccess: (result) => {
      refresh();
      setEditing(null);
      toast.success(t('Saved “{name}”', { name: result.document.title }), {
        description:
          result.document.embeddingModel === ''
            ? plural(
                result.document.chunkCount,
                '{n} passage indexed; its vectors are being computed in the background.',
                '{n} passages indexed; their vectors are being computed in the background.',
              )
            : plural(
                result.document.chunkCount,
                '{n} passage indexed and ready to be retrieved.',
                '{n} passages indexed and ready to be retrieved.',
              ),
      });
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('Could not save that document.')),
  });

  // A patch, not a read-then-save: the switch changes one boolean, and a
  // file-backed document's text is refused on the way back in anyway.
  const toggle = useMutation({
    mutationFn: (meta: KnowledgeDocumentMeta) =>
      api.knowledge.patch(meta.id, { enabled: !meta.enabled }),
    onSuccess: refresh,
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('Could not update that document.')),
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
          : plural(result.affected, '{n} passage re-embedded.', '{n} passages re-embedded.'),
      );
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('Could not re-index.')),
  });

  const extract = useMutation({
    mutationFn: (id: string) => api.knowledge.extract(id),
    onSuccess: (result) => {
      refresh();
      toast.success(t('Read again with {engine}', { engine: result.document.source?.extractor ?? '' }), {
        description: plural(
          result.document.chunkCount,
          '{n} passage indexed',
          '{n} passages indexed',
        ),
      });
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('Could not re-extract that file.')),
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
      toast.error(error instanceof ApiError ? error.message : t('Could not delete that document.')),
  });

  /** Open the editor for a document, fetching its text only when it has one. */
  const openFor = async (meta: KnowledgeDocumentMeta): Promise<void> => {
    const reach: ExtensionReach = { global: meta.isGlobal, workspaceIds: meta.workspaceIds };
    if (meta.source) {
      setEditing({
        id: meta.id,
        title: meta.title,
        content: '',
        reach,
        enabled: meta.enabled,
        fromFile: true,
      });
      return;
    }
    try {
      const { document } = await api.knowledge.get(meta.id);
      setEditing({
        id: document.id,
        title: document.title,
        content: document.content,
        reach,
        enabled: document.enabled,
        fromFile: false,
      });
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : t('Could not open that document.'));
    }
  };

  const documents = query.data?.documents ?? [];
  const visible = useMemo(
    () => documents.filter((doc) => matchesTitle(doc, titleQuery)),
    [documents, titleQuery],
  );
  const hidden = documents.length - visible.length;

  return (
    <Section
      title={t('Knowledge library')}
      icon={<BookOpenCheck className="text-accent" />}
      description={t(
        'Reference documents the agent can quote — a lease, a spec, a runbook. Drop a file or paste text, then choose which workspaces it reaches. Runs retrieve the relevant passages automatically and cite them by page and line.',
      )}
      actions={
        <>
          {documents.length > 0 ? (
            // The app's Tooltip, not a `title` attribute: the native one is
            // unstyled, sits outside the charter, and never appears on touch —
            // where this screen is used as much as on a desktop.
            <Tooltip
              content={t(
                'Recompute every passage’s embedding — needed after changing embedding provider.',
              )}
            >
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
          <Button
            variant="primary"
            size="sm"
            onClick={() =>
              setEditing({
                title: '',
                content: '',
                reach: reachForScope(scope),
                enabled: true,
                fromFile: false,
              })
            }
          >
            <Plus className="size-4" />
            {t('Paste a document')}
          </Button>
        </>
      }
    >
      {/* The rhythm belongs to the body: `Section` already spaces its header
          from its content, so `space-y` on the enclosure itself would set the
          same margin twice on the same child. */}
      <div className="space-y-4">
        {/* The row scrolls rather than wraps: it sits above the list, so every
            row it grows steals one from the library on a phone. The workspace
            filter is the page's, at the top — one question, one control. */}
        <div className={cn(FILTER_ROW, 'gap-2')}>
          {/* "Find a document", not "Search": the rehearsal card below is also a
              search box, and it answers a different question — what a *run*
              would be shown. Two boxes labelled the same way on one screen is
              two ways to be surprised. */}
          <Input
            value={titleQuery}
            onChange={(event) => setTitleQuery(event.target.value)}
            placeholder={t('Filter by name')}
            aria-label={t('Find a document')}
            className="w-44 sm:w-56"
          />
          {/* Kept visible when the list is empty: hiding the controls with the
              list is how an operator gets stuck inside an empty scope. */}
          <span className="text-caption text-subtle">
            {plural(visible.length, '{n} document', '{n} documents')}
            {hidden > 0 ? ` · ${t('{n} hidden', { n: String(hidden) })}` : ''}
          </span>
        </div>

        <KnowledgeUploadZone reach={reachForScope(scope)} onUploaded={refresh} />

        {query.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </div>
        ) : visible.length === 0 ? (
          <Card>
            <EmptyState
              icon={<FileText />}
              title={documents.length === 0 ? t('Nothing on the shelf yet') : t('No document matches')}
              description={
                documents.length === 0
                  ? t(
                      'Drop the documents your runs keep needing — the contract, the conventions, the runbook — and the agent will cite them instead of guessing.',
                    )
                  : t('Try another word, or widen the workspace filter.')
              }
            />
          </Card>
        ) : (
          <div className="space-y-2">
            {visible.map((doc) => (
              <Card key={doc.id} className="p-3.5">
                <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          doc.source ? setViewing({ id: doc.id, line: null }) : void openFor(doc)
                        }
                        className="truncate text-left text-body font-medium text-ink transition-colors hover:text-accent"
                      >
                        {doc.title}
                      </button>
                      {formatLabel(doc.source) ? (
                        <Badge tone="neutral">{formatLabel(doc.source)}</Badge>
                      ) : null}
                      <ReachBadge
                        global={doc.isGlobal}
                        workspaceIds={doc.workspaceIds}
                        workspaces={workspaces}
                      />
                      {!doc.enabled ? <Badge tone="warning">{t('Paused')}</Badge> : null}
                      {pendingVectors(doc) ? (
                        <Tooltip
                          content={t(
                            'Findable by its words already; its vectors are being computed in the background.',
                          )}
                        >
                          <span className="inline-flex">
                            <Badge tone="thinking">{t('Vectors pending')}</Badge>
                          </span>
                        </Tooltip>
                      ) : null}
                    </div>
                    <p className="text-caption text-subtle">
                      {plural(doc.chunkCount, '{n} passage', '{n} passages')} ·{' '}
                      {formatBytes(doc.contentLength)}
                      {doc.pageCount !== null
                        ? ` · ${plural(doc.pageCount, '{n} page', '{n} pages')}`
                        : ''}{' '}
                      · {formatRelative(doc.updatedAt)}
                    </p>
                  </div>

                  <div className="flex items-center gap-2 sm:shrink-0">
                    <Switch
                      checked={doc.enabled}
                      onChange={() => toggle.mutate(doc)}
                      label={t('Retrieve from “{name}”', { name: doc.title })}
                      tooltip={
                        doc.enabled
                          ? t('On: runs can retrieve these passages. Switch off to pause without deleting.')
                          : t('Paused: kept and editable, but never retrieved.')
                      }
                    />
                    <Menu
                      side="bottom"
                      align="end"
                      trigger={
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('More actions for “{name}”', { name: doc.title })}
                        >
                          <MoreVertical className="size-4" />
                        </Button>
                      }
                    >
                      {doc.source ? (
                        <MenuItem
                          icon={<Eye className="size-4" />}
                          onSelect={() => setViewing({ id: doc.id, line: null })}
                        >
                          {t('View')}
                        </MenuItem>
                      ) : null}
                      <MenuItem icon={<Pencil className="size-4" />} onSelect={() => void openFor(doc)}>
                        {doc.source ? t('Rename and re-aim') : t('Edit')}
                      </MenuItem>
                      {doc.source ? (
                        <MenuItem
                          icon={<Download className="size-4" />}
                          onSelect={() => {
                            window.location.assign(api.knowledge.sourceUrl(doc.id));
                          }}
                        >
                          {t('Download the original')}
                        </MenuItem>
                      ) : null}
                      {doc.source ? (
                        <MenuItem
                          icon={<RefreshCw className="size-4" />}
                          onSelect={() => extract.mutate(doc.id)}
                        >
                          {t('Read the file again')}
                        </MenuItem>
                      ) : null}
                      <MenuItem
                        icon={<Trash2 className="size-4" />}
                        tone="danger"
                        onSelect={() => setDeleting(doc)}
                      >
                        {t('Delete')}
                      </MenuItem>
                    </Menu>
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
                  {preview.data!.results.map((hit) => {
                    const where = formatLocation(hit, t);
                    return (
                      <li key={hit.chunkId} className="rounded-lg border border-line bg-sunken/40 p-3">
                        <p className="flex flex-wrap items-baseline gap-x-2 text-caption font-medium text-accent">
                          <button
                            type="button"
                            className="text-left hover:underline"
                            onClick={() => setViewing({ id: hit.documentId, line: hit.lineStart })}
                          >
                            {[hit.documentTitle, hit.heading].filter(Boolean).join(' › ')}
                          </button>
                          {where ? <span className="text-subtle">{where}</span> : null}
                          <span className="font-mono text-caption text-subtle">
                            {hit.score.toFixed(3)}
                          </span>
                        </p>
                        <p className="mt-1 line-clamp-3 text-caption leading-relaxed text-muted">
                          {hit.text}
                        </p>
                      </li>
                    );
                  })}
                </ul>
              )
            ) : null}
          </Card>
        ) : null}
      </div>

      <KnowledgeViewer
        documentId={viewing?.id ?? null}
        line={viewing?.line ?? null}
        onOpenChange={(open) => {
          if (!open) {
            setViewing(null);
            onViewerClosed?.();
          }
        }}
        onChanged={refresh}
      />

      <Modal
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        title={
          editing?.fromFile
            ? t('Rename and re-aim')
            : editing?.id
              ? t('Edit document')
              : t('Paste a document')
        }
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

            <ReachPicker
              value={editing.reach}
              workspaces={workspaces}
              onChange={(reach) => setEditing({ ...editing, reach })}
            />

            {editing.fromFile ? (
              <p className="text-caption leading-relaxed text-muted">
                {t(
                  'This document was read from a file, so its text is not edited here — read the file again to pick up an extractor improvement.',
                )}
              </p>
            ) : (
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
            )}

            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(null)}>
                {t('Cancel')}
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                loading={save.isPending}
                disabled={
                  !editing.title.trim() ||
                  (!editing.fromFile && !editing.content.trim()) ||
                  save.isPending
                }
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
            {deleting?.source
              ? t(
                  'and every passage indexed from it are removed, along with the original file. Runs stop seeing it immediately.',
                )
              : t('and every passage indexed from it are removed. Runs stop seeing it immediately.')}
          </>
        }
        confirmLabel={t('Delete document')}
        danger
        onConfirm={async () => {
          if (deleting) await remove.mutateAsync(deleting.id);
          setDeleting(null);
        }}
      />
    </Section>
  );
}
