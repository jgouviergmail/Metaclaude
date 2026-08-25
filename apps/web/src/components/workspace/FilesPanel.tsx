/**
 * Workspace file explorer and editor.
 *
 * Two modes in one panel: a directory listing (or a filename search, when the
 * box has something in it) and a CodeMirror editor for a single file. Keeping
 * them in one component means the breadcrumb, the refresh and the close button
 * behave identically either way.
 *
 * Language support is code-split. The editor is already a large chunk; pulling
 * in nine grammars for a file that needs one would double it, so each grammar
 * is imported on demand once a file's language is known.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { oneDark } from '@codemirror/theme-one-dark';
import CodeMirror, { type Extension } from '@uiw/react-codemirror';
import {
  ArrowLeft,
  ChevronRight,
  File as FileIcon,
  FileWarning,
  Folder,
  Home,
  RefreshCw,
  Save,
  Search,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { FileEntry } from '@metaclaude/shared';
import { Button, EmptyState, Input, Spinner, Tooltip } from '@/components/ui/primitives';
import { api, ApiError } from '@/lib/api';
import { cn, formatBytes, isModifier, shortcut, truncate } from '@/lib/utils';

export function FilesPanel({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const queryClient = useQueryClient();

  const [path, setPath] = useState('');
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');

  // Typing a path fragment fires a recursive walk on the server; wait for a
  // pause before spending that.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  const searching = debouncedQuery.length >= 2;

  const listing = useQuery({
    queryKey: ['files', workspaceId, path],
    queryFn: () => api.files(workspaceId, path),
  });

  const search = useQuery({
    queryKey: ['file-search', workspaceId, debouncedQuery],
    queryFn: () => api.searchFiles(workspaceId, debouncedQuery),
    enabled: searching,
  });

  const refresh = (): void => {
    if (openPath) void queryClient.invalidateQueries({ queryKey: ['file', workspaceId, openPath] });
    else if (searching) void search.refetch();
    else void queryClient.invalidateQueries({ queryKey: ['files', workspaceId, path] });
  };

  const openEntry = (entry: FileEntry): void => {
    if (entry.type === 'directory') {
      setPath(entry.path);
      setQuery('');
      setDebouncedQuery('');
      return;
    }
    setOpenPath(entry.path);
  };

  const entries = searching ? (search.data?.entries ?? []) : (listing.data?.entries ?? []);
  const loading = searching ? search.isPending : listing.isPending;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">Files</h2>

        <Tooltip content="Refresh">
          <Button variant="ghost" size="icon-sm" aria-label="Refresh files" onClick={refresh}>
            <RefreshCw className="size-4" />
          </Button>
        </Tooltip>

        <Button variant="ghost" size="icon-sm" aria-label="Close files" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </header>

      {openPath ? (
        <FileEditor
          workspaceId={workspaceId}
          path={openPath}
          onBack={() => setOpenPath(null)}
        />
      ) : (
        <>
          <div className="shrink-0 space-y-2 border-b border-line px-3 py-2">
            <Breadcrumb path={path} onNavigate={setPath} />

            <div className="relative">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-subtle"
                aria-hidden
              />
              <Input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Find a file by name"
                aria-label="Find a file by name"
                className="h-8 pl-8 text-[13px]"
              />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {loading ? (
              <div className="flex justify-center py-10">
                <Spinner />
              </div>
            ) : listing.isError && !searching ? (
              <EmptyState
                icon={<FileWarning />}
                title="This folder could not be read"
                description={
                  listing.error instanceof ApiError
                    ? listing.error.message
                    : 'The directory may have been moved or deleted.'
                }
                action={
                  <Button variant="secondary" size="sm" onClick={() => setPath('')}>
                    Back to the root
                  </Button>
                }
              />
            ) : entries.length === 0 ? (
              <EmptyState
                icon={<Folder />}
                title={searching ? 'Nothing matched' : 'This folder is empty'}
                description={
                  searching ? `No file name contains “${debouncedQuery}”.` : undefined
                }
              />
            ) : (
              <ul>
                {entries.map((entry) => (
                  <li key={entry.path}>
                    <button
                      type="button"
                      onClick={() => openEntry(entry)}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-raised"
                    >
                      {entry.type === 'directory' ? (
                        <Folder className="size-4 shrink-0 text-accent" aria-hidden />
                      ) : (
                        <FileIcon className="size-4 shrink-0 text-subtle" aria-hidden />
                      )}

                      <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
                        {entry.name}
                      </span>

                      {/* In search results the name alone is ambiguous, so show
                          where the file actually lives instead of its size. */}
                      <span className="shrink-0 text-[11px] tabular-nums text-subtle">
                        {searching
                          ? truncate(entry.path, 34)
                          : entry.type === 'file'
                            ? formatBytes(entry.size)
                            : ''}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Breadcrumb                                                                  */
/* -------------------------------------------------------------------------- */

function Breadcrumb({ path, onNavigate }: { path: string; onNavigate: (path: string) => void }) {
  const segments = path ? path.split('/').filter(Boolean) : [];

  return (
    <nav className="flex flex-wrap items-center gap-0.5 text-[12px]" aria-label="Folder path">
      <button
        type="button"
        onClick={() => onNavigate('')}
        aria-label="Workspace root"
        className="flex items-center rounded px-1 py-0.5 text-subtle transition-colors hover:bg-raised hover:text-ink"
      >
        <Home className="size-3.5" aria-hidden />
      </button>

      {segments.map((segment, index) => {
        const target = segments.slice(0, index + 1).join('/');
        const last = index === segments.length - 1;
        return (
          <span key={target} className="flex items-center gap-0.5">
            <ChevronRight className="size-3 shrink-0 text-subtle" aria-hidden />
            <button
              type="button"
              onClick={() => onNavigate(target)}
              disabled={last}
              className={cn(
                'rounded px-1 py-0.5 transition-colors',
                last
                  ? 'font-medium text-ink'
                  : 'text-muted hover:bg-raised hover:text-ink',
              )}
            >
              {segment}
            </button>
          </span>
        );
      })}
    </nav>
  );
}

/* -------------------------------------------------------------------------- */
/* Editor                                                                      */
/* -------------------------------------------------------------------------- */

function FileEditor({
  workspaceId,
  path,
  onBack,
}: {
  workspaceId: string;
  path: string;
  onBack: () => void;
}) {
  const queryClient = useQueryClient();
  const dark = useDarkTheme();

  const [draft, setDraft] = useState('');
  const [baseline, setBaseline] = useState('');
  const [language, setLanguage] = useState<Extension | null>(null);

  const file = useQuery({
    queryKey: ['file', workspaceId, path],
    queryFn: () => api.readFile(workspaceId, path),
    // A binary or missing file will fail the same way every time; retrying only
    // delays the message.
    retry: false,
    staleTime: Infinity,
  });

  // Re-seed the buffer whenever the file is (re)fetched. `dataUpdatedAt` is in
  // the deps so an explicit refresh discards the draft along with the old text.
  useEffect(() => {
    if (!file.data) return;
    setDraft(file.data.content);
    setBaseline(file.data.content);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.data?.path, file.dataUpdatedAt]);

  useEffect(() => {
    let cancelled = false;
    setLanguage(null);
    const name = file.data?.language;
    if (!name) return;

    void languageExtension(name).then((extension) => {
      if (!cancelled) setLanguage(extension);
    });
    return () => {
      cancelled = true;
    };
  }, [file.data?.language]);

  const save = useMutation({
    mutationFn: (content: string) => api.writeFile(workspaceId, path, content),
    onSuccess: (_data, content) => {
      setBaseline(content);
      toast.success(`Saved ${path.split('/').pop() ?? path}`);
      // The listing carries size and mtime, both of which just changed.
      void queryClient.invalidateQueries({ queryKey: ['files', workspaceId] });
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'Could not save the file.'),
  });

  const truncated = file.data?.truncated ?? false;
  const dirty = draft !== baseline;
  const canSave = dirty && !truncated && !save.isPending;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== 's' || !isModifier(event)) return;
      // Always swallow it: the browser's "save page" dialog over an editor is
      // never what the shortcut was aimed at.
      event.preventDefault();
      if (canSave) save.mutate(draft);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [canSave, draft, save.mutate]);

  const extensions = useMemo(() => (language ? [language] : []), [language]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-2 py-2">
        <Button variant="ghost" size="icon-sm" aria-label="Back to files" onClick={onBack}>
          <ArrowLeft className="size-4" />
        </Button>

        <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted" title={path}>
          {path}
        </code>

        {dirty ? (
          <span
            className="size-1.5 shrink-0 rounded-full bg-warning"
            role="img"
            aria-label="Unsaved changes"
            title="Unsaved changes"
          />
        ) : null}

        <Tooltip content={`Save (${shortcut('S')})`}>
          <Button
            variant="primary"
            size="sm"
            onClick={() => save.mutate(draft)}
            disabled={!canSave}
            loading={save.isPending}
          >
            <Save className="size-3.5" aria-hidden />
            Save
          </Button>
        </Tooltip>
      </div>

      {file.isPending ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner />
        </div>
      ) : file.isError ? (
        <EmptyState
          icon={<FileWarning />}
          title={readErrorTitle(file.error)}
          description={
            file.error instanceof ApiError
              ? file.error.message
              : 'The file could not be read.'
          }
          action={
            <Button variant="secondary" size="sm" onClick={onBack}>
              <ArrowLeft className="size-4" />
              Back to files
            </Button>
          }
        />
      ) : (
        <>
          {truncated ? (
            <p className="flex shrink-0 items-start gap-2 border-b border-line bg-warning-soft px-3 py-2 text-[12px] leading-relaxed text-warning">
              <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
              <span>
                This file is {formatBytes(file.data.size)} — only the beginning is shown. Editing
                is disabled, because saving what is on screen would truncate the file on disk.
              </span>
            </p>
          ) : null}

          <div className="min-h-0 flex-1 overflow-auto text-[13px]">
            <CodeMirror
              value={draft}
              onChange={setDraft}
              extensions={extensions}
              // `oneDark` is the only dark editor theme in the bundle; in light
              // mode CodeMirror's own default already matches the surface.
              theme={dark ? oneDark : 'light'}
              editable={!truncated}
              height="100%"
              basicSetup={{ foldGutter: false, highlightActiveLine: !truncated }}
              aria-label={`Contents of ${path}`}
            />
          </div>
        </>
      )}
    </div>
  );
}

function readErrorTitle(error: unknown): string {
  if (error instanceof ApiError && error.status === 415) return 'This file is not text';
  if (error instanceof ApiError && error.status === 404) return 'This file no longer exists';
  return 'This file could not be opened';
}

/** The theme switch only toggles a class, so watch for it rather than polling. */
function useDarkTheme(): boolean {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setDark(document.documentElement.classList.contains('dark'));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  return dark;
}

/**
 * Resolve a language name from the server to a CodeMirror extension.
 * Anything not listed renders as plain text, which is a perfectly usable
 * editor — a missing grammar is not an error worth surfacing.
 */
async function languageExtension(language: string): Promise<Extension | null> {
  switch (language) {
    case 'typescript':
    case 'tsx':
    case 'javascript':
    case 'jsx': {
      const { javascript } = await import('@codemirror/lang-javascript');
      return javascript({ jsx: true, typescript: true });
    }
    case 'json': {
      const { json } = await import('@codemirror/lang-json');
      return json();
    }
    case 'markdown': {
      const { markdown } = await import('@codemirror/lang-markdown');
      return markdown();
    }
    case 'python': {
      const { python } = await import('@codemirror/lang-python');
      return python();
    }
    case 'rust': {
      const { rust } = await import('@codemirror/lang-rust');
      return rust();
    }
    case 'css':
    case 'scss':
    case 'less': {
      const { css } = await import('@codemirror/lang-css');
      return css();
    }
    case 'html':
    case 'vue':
    case 'svelte': {
      const { html } = await import('@codemirror/lang-html');
      return html();
    }
    case 'sql': {
      const { sql } = await import('@codemirror/lang-sql');
      return sql();
    }
    default:
      return null;
  }
}
