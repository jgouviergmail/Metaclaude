/**
 * Source-control panel.
 *
 * Deliberately a review surface rather than a full git client: see what the
 * agent changed, read the diff, stage what is right and commit it. Anything
 * that rewrites history stays in the terminal, where the safeguards are.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  GitBranch,
  GitCommitHorizontal,
  Minus,
  Plus,
  RefreshCw,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { DiffView } from '@/components/transcript/DiffView';
import {
  Badge,
  Button,
  EmptyState,
  Input,
  Label,
  Spinner,
  Textarea,
  Tooltip,
} from '@/components/ui/primitives';
import { api, ApiError } from '@/lib/api';
import { cn, formatRelative } from '@/lib/utils';
import { useT } from '@/lib/i18n';

/** A file the user has clicked, and which side of the index to diff it against. */
interface Selection {
  path: string;
  staged: boolean;
}

type SectionKey = 'staged' | 'modified' | 'untracked' | 'conflicted';

const SECTIONS: Array<{ key: SectionKey; label: string; staged: boolean }> = [
  { key: 'staged', label: 'Staged', staged: true },
  { key: 'modified', label: 'Modified', staged: false },
  { key: 'untracked', label: 'Untracked', staged: false },
  { key: 'conflicted', label: 'Conflicted', staged: false },
];

export function GitPanel({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const t = useT();
  const queryClient = useQueryClient();

  const [message, setMessage] = useState('');
  const [selected, setSelected] = useState<Selection | null>(null);
  const [collapsed, setCollapsed] = useState<Partial<Record<SectionKey, boolean>>>({});

  const status = useQuery({
    queryKey: ['git-status', workspaceId],
    queryFn: () => api.gitStatus(workspaceId),
  });

  const log = useQuery({
    queryKey: ['git-log', workspaceId],
    queryFn: () => api.gitLog(workspaceId, 15),
    enabled: status.data?.isRepo === true,
  });

  const diff = useQuery({
    queryKey: ['git-diff', workspaceId, selected?.path ?? null, selected?.staged ?? false],
    queryFn: async () => (selected ? api.gitDiff(workspaceId, selected) : { diff: '', files: [] }),
    enabled: selected !== null,
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['git-status', workspaceId] });
    void queryClient.invalidateQueries({ queryKey: ['git-diff', workspaceId] });
  };

  const fail = (error: unknown, fallback: string): void => {
    toast.error(error instanceof ApiError ? error.message : fallback);
  };

  const stage = useMutation({
    mutationFn: (paths: string[]) => api.gitStage(workspaceId, paths),
    onSuccess: invalidate,
    onError: (error) => fail(error, t('Could not stage those files.')),
  });

  const unstage = useMutation({
    mutationFn: (paths: string[]) => api.gitUnstage(workspaceId, paths),
    onSuccess: invalidate,
    onError: (error) => fail(error, t('Could not unstage those files.')),
  });

  const commit = useMutation({
    mutationFn: (text: string) => api.gitCommit(workspaceId, text),
    onSuccess: (result) => {
      toast.success(t('Committed {hash}', { hash: result.hash.slice(0, 7) }));
      setMessage('');
      setSelected(null);
      invalidate();
      void queryClient.invalidateQueries({ queryKey: ['git-log', workspaceId] });
    },
    onError: (error) => fail(error, t('The commit failed.')),
  });

  const data = status.data;
  const busy = stage.isPending || unstage.isPending;

  const header = (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
      <h2 className="shrink-0 text-body font-semibold text-ink">{t('Source control')}</h2>

      {data?.isRepo && data.branch ? (
        <Badge tone="accent" className="min-w-0">
          <GitBranch className="size-3 shrink-0" aria-hidden />
          <span className="truncate">{data.branch}</span>
        </Badge>
      ) : null}

      {data && data.ahead > 0 ? (
        <span className="flex items-center gap-0.5 text-caption tabular-nums text-muted">
          <ArrowUp className="size-3" aria-hidden />
          <span aria-label={`${data.ahead} commits ahead`}>{data.ahead}</span>
        </span>
      ) : null}

      {data && data.behind > 0 ? (
        <span className="flex items-center gap-0.5 text-caption tabular-nums text-muted">
          <ArrowDown className="size-3" aria-hidden />
          <span aria-label={`${data.behind} commits behind`}>{data.behind}</span>
        </span>
      ) : null}

      <div className="ml-auto flex shrink-0 items-center gap-1">
        <Tooltip content={t('Refresh')}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('Refresh source control')}
            onClick={() => {
              invalidate();
              void queryClient.invalidateQueries({ queryKey: ['git-log', workspaceId] });
            }}
          >
            <RefreshCw className={cn('size-4', status.isFetching && 'animate-spin')} />
          </Button>
        </Tooltip>

        <Button variant="ghost" size="icon-sm" aria-label={t(
          'Close source control',
        )} onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>
    </header>
  );

  if (status.isPending) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {header}
        <div className="flex flex-1 items-center justify-center">
          <Spinner />
        </div>
      </div>
    );
  }

  if (status.isError) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {header}
        <EmptyState
          icon={<GitBranch />}
          title={t('Git status is unavailable')}
          description={
            status.error instanceof ApiError
              ? status.error.message
              : t('The repository status could not be read.')
          }
        />
      </div>
    );
  }

  if (!data?.isRepo) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {header}
        <ConnectRepository workspaceId={workspaceId} onConnected={invalidate} />
      </div>
    );
  }

  const unstaged = [...data.modified, ...data.untracked, ...data.conflicted];
  const canCommit = message.trim().length > 0 && data.staged.length > 0 && !commit.isPending;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {header}

      <div className="shrink-0 space-y-2 border-b border-line p-3">
        <Textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder={t('Commit message')}
          aria-label={t('Commit message')}
          rows={2}
          className="text-body"
        />
        <div className="flex items-center gap-2">
          <span className="text-caption tabular-nums text-subtle">
            {data.staged.length} {t('staged')}
          </span>
          <Button
            variant="primary"
            size="sm"
            className="ml-auto"
            onClick={() => commit.mutate(message.trim())}
            disabled={!canCommit}
            loading={commit.isPending}
          >
            <GitCommitHorizontal className="size-3.5" aria-hidden />
            {t('Commit')}
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {unstaged.length > 0 ? (
          <div className="flex items-center justify-end border-b border-line px-3 py-1.5">
            <Button
              variant="ghost"
              size="xs"
              onClick={() => stage.mutate(unstaged)}
              disabled={busy}
            >
              <Plus className="size-3" aria-hidden />
              {t('Stage all')}
            </Button>
          </div>
        ) : null}

        {SECTIONS.map((section) => {
          const paths = data[section.key];
          if (paths.length === 0) return null;
          const open = collapsed[section.key] !== true;

          return (
            <section key={section.key} className="border-b border-line">
              <button
                type="button"
                aria-expanded={open}
                onClick={() =>
                  setCollapsed((previous) => ({ ...previous, [section.key]: open }))
                }
                className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left hover:bg-raised"
              >
                <ChevronRight
                  className={cn(
                    'size-3.5 shrink-0 text-subtle transition-transform duration-150',
                    open && 'rotate-90',
                  )}
                  aria-hidden
                />
                <span className="text-caption font-semibold uppercase tracking-wide text-subtle">
                  {t(section.label)}
                </span>
                <span className="text-caption tabular-nums text-subtle">{paths.length}</span>
              </button>

              {open ? (
                <ul className="pb-1">
                  {paths.map((path) => (
                    <FileRow
                      key={`${section.key}:${path}`}
                      path={path}
                      selected={selected?.path === path && selected.staged === section.staged}
                      staged={section.key === 'staged'}
                      busy={busy}
                      onSelect={() =>
                        setSelected((current) =>
                          current?.path === path && current.staged === section.staged
                            ? null
                            : { path, staged: section.staged },
                        )
                      }
                      onStage={() => stage.mutate([path])}
                      onUnstage={() => unstage.mutate([path])}
                    />
                  ))}
                </ul>
              ) : null}
            </section>
          );
        })}

        {selected ? (
          <div className="border-b border-line p-2">
            {diff.isPending ? (
              <div className="flex justify-center py-6">
                <Spinner />
              </div>
            ) : diff.isError ? (
              <p className="px-1 py-4 text-center text-caption text-danger">
                {diff.error instanceof ApiError
                  ? diff.error.message
                  : t('That diff could not be loaded.')}
              </p>
            ) : diff.data.diff.trim() === '' ? (
              // `git diff` says nothing about a path it has never seen, which is
              // exactly the case for every untracked file.
              <p className="px-1 py-4 text-center text-caption text-muted">
                {t(
                  'No diff to show — an untracked file has no previous version to compare against.',
                )}
              </p>
            ) : (
              <DiffView patch={diff.data.diff} path={selected.path} />
            )}
          </div>
        ) : null}

        <RecentCommits
          commits={log.data?.commits ?? []}
          loading={log.isPending}
        />
      </div>
    </div>
  );
}

function FileRow({
  path,
  selected,
  staged,
  busy,
  onSelect,
  onStage,
  onUnstage,
}: {
  path: string;
  selected: boolean;
  staged: boolean;
  busy: boolean;
  onSelect: () => void;
  onStage: () => void;
  onUnstage: () => void;
}) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const directory = path.slice(0, path.length - name.length);

  return (
    <li className="group flex items-center gap-1 px-2">
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={cn(
          'flex min-w-0 flex-1 items-baseline gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors',
          selected ? 'bg-accent-soft' : 'hover:bg-raised',
        )}
      >
        <span className="truncate font-mono text-caption text-ink">{name}</span>
        {directory ? (
          <span className="min-w-0 shrink truncate font-mono text-caption text-subtle">
            {directory.replace(/\/$/, '')}
          </span>
        ) : null}
      </button>

      <Tooltip content={staged ? 'Unstage' : 'Stage'}>
        <button
          type="button"
          onClick={staged ? onUnstage : onStage}
          disabled={busy}
          aria-label={`${staged ? 'Unstage' : 'Stage'} ${path}`}
          className={cn(
            'flex size-6 shrink-0 items-center justify-center rounded-md text-subtle',
            'transition-colors hover:bg-raised hover:text-ink disabled:opacity-40',
            'opacity-0 focus-visible:opacity-100 group-hover:opacity-100',
          )}
        >
          {staged ? <Minus className="size-3.5" aria-hidden /> : <Plus className="size-3.5" aria-hidden />}
        </button>
      </Tooltip>
    </li>
  );
}

function RecentCommits({
  commits,
  loading,
}: {
  commits: Array<{ hash: string; author: string; date: number; subject: string }>;
  loading: boolean;
}) {
  const t = useT();
  return (
    <section className="p-2">
      <h3 className="px-1.5 py-1 text-caption font-semibold uppercase tracking-wide text-subtle">
        {t('Recent commits')}
      </h3>

      {loading ? (
        <div className="flex justify-center py-4">
          <Spinner />
        </div>
      ) : commits.length === 0 ? (
        <p className="px-1.5 py-3 text-caption text-muted">{t('No commits yet.')}</p>
      ) : (
        <ul className="space-y-0.5">
          {commits.map((entry) => (
            <li key={entry.hash} className="rounded-md px-1.5 py-1.5 hover:bg-raised">
              <div className="flex items-baseline gap-2">
                <code className="shrink-0 font-mono text-caption text-accent">
                  {entry.hash.slice(0, 7)}
                </code>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-caption text-ink">{entry.subject}</p>
                  <p className="mt-0.5 flex items-center gap-1.5 text-caption text-subtle">
                    <span className="truncate">{entry.author}</span>
                    <span aria-hidden>·</span>
                    <span className="shrink-0">{formatRelative(entry.date)}</span>
                  </p>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Connecting a repository, from the panel that noticed there wasn't one.
 *
 * This screen used to be a dead end that said "run `git init` in the
 * workspace" — advice that requires the shell this product exists to replace.
 * Cloning was possible exactly once, in a field inside the create-workspace
 * modal, and never again.
 */
function ConnectRepository({
  workspaceId,
  onConnected,
}: {
  workspaceId: string;
  onConnected: () => void;
}) {
  const t = useT();
  const [url, setUrl] = useState('');

  const connect = useMutation({
    mutationFn: (gitUrl: string | null) => api.connectRepository(workspaceId, gitUrl),
    onSuccess: (result) => {
      onConnected();
      if (result.mode === 'cloned') {
        toast.success(`Cloned${result.branch ? ` — on ${result.branch}` : ''}.`);
      } else if (result.mode === 'initialised') {
        toast.success(t('Now tracking this workspace with git.'));
      } else {
        // Deliberately not a plain success: the working tree was left alone and
        // the owner needs to know that before they go looking for the files.
        toast.info(t('Remote added and fetched. Your existing files were left untouched.'));
      }
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t(
        'Could not connect that repository.',
      )),
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 p-6 text-center">
      <div className="flex size-12 items-center justify-center rounded-2xl bg-accent-soft text-accent">
        <GitBranch className="size-6" aria-hidden />
      </div>

      <div className="space-y-1">
        <h3 className="text-title font-semibold text-ink">{t('No repository yet')}</h3>
        <p className="max-w-sm text-body text-muted">
          {t('Clone one into this workspace, or start tracking the files that are already here.')}
        </p>
      </div>

      <div className="w-full max-w-sm space-y-2 text-left">
        <Label htmlFor="git-connect-url">{t('Repository URL')}</Label>
        <Input
          id="git-connect-url"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://github.com/owner/repo.git"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && url.trim()) connect.mutate(url.trim());
          }}
        />
        <p className="text-caption text-subtle">
          {t('https or ssh. A private repository needs its credentials already on the server.')}
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={!url.trim()}
          loading={connect.isPending && connect.variables !== null}
          onClick={() => connect.mutate(url.trim())}
        >
          {t('Clone into this workspace')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          loading={connect.isPending && connect.variables === null}
          onClick={() => connect.mutate(null)}
        >
          {t('Just track it locally')}
        </Button>
      </div>
    </div>
  );
}
