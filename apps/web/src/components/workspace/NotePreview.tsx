/**
 * A note, read the way it was written to be read.
 *
 * Rendered markdown with live wikilinks, the note's local graph, and its
 * backlinks — the three things Obsidian users reach for, served straight
 * from the workspace's own files. Clicks on wikilinks stay inside the
 * panel: the preview intercepts them and opens the target note in place of
 * a navigation to nowhere.
 */

import { useQuery } from '@tanstack/react-query';
import { Link2, Unlink } from 'lucide-react';
import { useMemo } from 'react';
import type { NoteEntry } from '@metaclaude/shared';
import { resolveLink } from '@metaclaude/shared';
import { api } from '@/lib/api';
import { renderNoteMarkdown } from '@/lib/markdown';
import { cn } from '@/lib/utils';
import { useT } from '@/lib/i18n';

export function NotePreview({
  workspaceId,
  path,
  content,
  onOpenNote,
}: {
  workspaceId: string;
  path: string;
  content: string;
  onOpenNote: (path: string) => void;
}) {
  const t = useT();
  const graph = useQuery({
    queryKey: ['notes-graph', workspaceId],
    queryFn: () => api.notesGraph(workspaceId),
    staleTime: 10_000,
  });
  const backlinks = useQuery({
    queryKey: ['note-backlinks', workspaceId, path],
    queryFn: () => api.noteBacklinks(workspaceId, path),
    staleTime: 10_000,
  });

  const notes = graph.data?.notes ?? [];
  const paths = useMemo(() => notes.map((note) => note.path), [notes]);
  const html = useMemo(
    () => renderNoteMarkdown(content, (target) => resolveLink(target, path, paths)),
    [content, path, paths],
  );

  const me = notes.find((note) => note.path === path);
  const incoming = notes.filter((note) => note.links.includes(path));
  const outgoing = notes.filter((note) => me?.links.includes(note.path));

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div
        className="prose-mc max-w-none px-4 py-4 text-ink sm:px-6"
        onClick={(event) => {
          const anchor = (event.target as Element).closest('a[data-note]');
          if (!anchor) return;
          event.preventDefault();
          const target = anchor.getAttribute('data-note');
          if (target) onOpenNote(target);
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />

      {me && (incoming.length > 0 || outgoing.length > 0) ? (
        <section className="border-t border-line px-4 py-3 sm:px-6" aria-label={t('Local graph')}>
          <h3 className="text-eyebrow uppercase text-subtle">{t(
            'Graph',
          )}</h3>
          <LocalGraph note={me} incoming={incoming} outgoing={outgoing} onOpenNote={onOpenNote} />
        </section>
      ) : null}

      <section className="border-t border-line px-4 py-3 sm:px-6" aria-label={t('Backlinks')}>
        <h3 className="text-eyebrow flex items-center gap-1.5 uppercase text-subtle">
          <Link2 className="size-3.5" aria-hidden />
          {t('Backlinks')}
          {backlinks.data ? <span>({backlinks.data.backlinks.length})</span> : null}
        </h3>
        {backlinks.data && backlinks.data.backlinks.length > 0 ? (
          <ul className="mt-2 space-y-2">
            {backlinks.data.backlinks.map((entry) => (
              <li key={entry.path}>
                <button
                  type="button"
                  onClick={() => onOpenNote(entry.path)}
                  className="block w-full rounded-lg border border-line px-3 py-2 text-left transition-colors hover:border-accent"
                >
                  <span className="block text-body font-medium text-ink">{entry.title}</span>
                  {entry.context ? (
                    <span className="mt-0.5 block truncate text-caption text-muted">
                      {entry.context}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1.5 text-caption text-muted">{t('Nothing links here yet.')}</p>
        )}
        {me && me.unresolved.length > 0 ? (
          <p className="mt-3 flex items-start gap-1.5 text-caption text-muted">
            <Unlink className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>
              {t('Links to notes that do not exist yet:')}{' '}
              {me.unresolved.map((target, index) => (
                <span key={target}>
                  {index > 0 ? ', ' : ''}
                  <span className="text-ink">{target}</span>
                </span>
              ))}
            </span>
          </p>
        ) : null}
      </section>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Local graph                                                                 */
/* -------------------------------------------------------------------------- */

const ROW = 34;
const NODE_W = 150;
const NODE_H = 26;
const GAP = 60;
const MAX_SIDE = 8;

/**
 * The note's neighbourhood as three columns: what links here, the note, what
 * it links to. Hand-drawn SVG on purpose — a force layout would cost a
 * library and determinism, and a note's one-hop neighbourhood reads better
 * as a list with edges than as a hairball.
 */
function LocalGraph({
  note,
  incoming,
  outgoing,
  onOpenNote,
}: {
  note: NoteEntry;
  incoming: NoteEntry[];
  outgoing: NoteEntry[];
  onOpenNote: (path: string) => void;
}) {
  const t = useT();
  const left = incoming.slice(0, MAX_SIDE);
  const right = outgoing.slice(0, MAX_SIDE);
  const rows = Math.max(left.length, right.length, 1);
  const height = rows * ROW + 8;
  const width = NODE_W * 3 + GAP * 2;
  const midY = height / 2;
  const rowY = (index: number, count: number): number =>
    midY + (index - (count - 1) / 2) * ROW;

  const truncate = (text: string): string =>
    text.length > 18 ? `${text.slice(0, 17)}…` : text;

  const node = (
    entry: { path: string; title: string },
    x: number,
    y: number,
    tone: 'center' | 'side',
  ) => (
    <g
      key={`${x}-${entry.path}`}
      transform={`translate(${x}, ${y - NODE_H / 2})`}
      role="button"
      tabIndex={0}
      aria-label={t('Open {title}', { title: entry.title })}
      className="cursor-pointer focus:outline-none"
      onClick={() => onOpenNote(entry.path)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onOpenNote(entry.path);
      }}
    >
      <rect
        width={NODE_W}
        height={NODE_H}
        rx={7}
        fill={tone === 'center' ? 'var(--mc-accent-soft)' : 'var(--mc-surface)'}
        stroke={tone === 'center' ? 'var(--mc-accent)' : 'var(--mc-border)'}
      />
      <text
        x={NODE_W / 2}
        y={NODE_H / 2 + 4}
        textAnchor="middle"
        className={cn('text-caption', tone === 'center' ? 'font-medium' : '')}
        fill={tone === 'center' ? 'var(--mc-accent)' : 'var(--mc-text)'}
      >
        {truncate(entry.title)}
      </text>
    </g>
  );

  const edge = (x1: number, y1: number, x2: number, y2: number, key: string) => (
    <path
      key={key}
      d={`M ${x1} ${y1} C ${x1 + GAP / 2} ${y1}, ${x2 - GAP / 2} ${y2}, ${x2} ${y2}`}
      fill="none"
      stroke="var(--mc-border-strong)"
      strokeWidth={1.2}
    />
  );

  return (
    <div className="mt-2 overflow-x-auto">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        style={{ maxWidth: width, minWidth: 460 }}
        role="img"
        aria-label={t('Local graph of {title}', { title: note.title })}
      >
        {left.map((entry, index) =>
          edge(NODE_W, rowY(index, left.length), NODE_W + GAP, midY, `in-${entry.path}`),
        )}
        {right.map((entry, index) =>
          edge(NODE_W * 2 + GAP, midY, NODE_W * 2 + GAP * 2, rowY(index, right.length), `out-${entry.path}`),
        )}
        {left.map((entry, index) => node(entry, 0, rowY(index, left.length), 'side'))}
        {node(note, NODE_W + GAP, midY, 'center')}
        {right.map((entry, index) => node(entry, NODE_W * 2 + GAP * 2, rowY(index, right.length), 'side'))}
      </svg>
      {incoming.length > MAX_SIDE || outgoing.length > MAX_SIDE ? (
        <p className="mt-1 text-caption text-subtle">
          {t('Showing {shownIn} of {totalIn} in, {shownOut} of {totalOut} out.', {
            shownIn: Math.min(incoming.length, MAX_SIDE),
            totalIn: incoming.length,
            shownOut: Math.min(outgoing.length, MAX_SIDE),
            totalOut: outgoing.length,
          })}
        </p>
      ) : null}
    </div>
  );
}
