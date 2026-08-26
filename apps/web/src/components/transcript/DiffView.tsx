/**
 * Unified diff viewer.
 *
 * Renders a patch with line numbers and add/remove colouring. Long diffs are
 * collapsed to a summary until asked for, because an agent that touched forty
 * files should not push the conversation off screen.
 */

import { ChevronRight, FileDiff, Minus, Plus } from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import { parseDiff, type DiffLine } from '@/lib/markdown';
import { cn } from '@/lib/utils';

/** Diffs longer than this start collapsed. */
const COLLAPSE_THRESHOLD = 40;

export const DiffView = memo(function DiffView({
  patch,
  path,
  additions,
  deletions,
  collapsible = false,
}: {
  patch: string;
  path?: string;
  additions?: number;
  deletions?: number;
  collapsible?: boolean;
}) {
  const lines = useMemo(() => parseDiff(patch), [patch]);
  const long = lines.length > COLLAPSE_THRESHOLD;
  const [expanded, setExpanded] = useState(!collapsible || !long);

  // Derive the counts when the caller did not supply them.
  const stats = useMemo(() => {
    if (additions !== undefined && deletions !== undefined) return { additions, deletions };
    let added = 0;
    let removed = 0;
    for (const line of lines) {
      if (line.type === 'add') added += 1;
      else if (line.type === 'remove') removed += 1;
    }
    return { additions: added, deletions: removed };
  }, [lines, additions, deletions]);

  const visible = expanded ? lines : lines.slice(0, 12);

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        disabled={!collapsible && !long}
        className={cn(
          'flex w-full items-center gap-2 px-3 py-2 text-left',
          (collapsible || long) && 'hover:bg-raised',
        )}
        aria-expanded={expanded}
      >
        {collapsible || long ? (
          <ChevronRight
            className={cn(
              'size-3.5 shrink-0 text-subtle transition-transform duration-150',
              expanded && 'rotate-90',
            )}
            aria-hidden
          />
        ) : (
          <FileDiff className="size-3.5 shrink-0 text-subtle" aria-hidden />
        )}

        <code className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink">
          {path ?? 'changes'}
        </code>

        <span className="flex shrink-0 items-center gap-2 text-[11px] tabular-nums">
          {stats.additions > 0 ? (
            <span className="flex items-center gap-0.5 text-success">
              <Plus className="size-3" aria-hidden />
              {stats.additions}
            </span>
          ) : null}
          {stats.deletions > 0 ? (
            <span className="flex items-center gap-0.5 text-danger">
              <Minus className="size-3" aria-hidden />
              {stats.deletions}
            </span>
          ) : null}
        </span>
      </button>

      {visible.length > 0 ? (
        <div className="overflow-x-auto border-t border-line">
          <table className="w-full border-collapse font-mono text-[12px] leading-[1.55]">
            <tbody>
              {visible.map((line, index) => (
                <DiffRow key={index} line={line} />
              ))}
            </tbody>
          </table>

          {!expanded && lines.length > visible.length ? (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="w-full bg-sunken py-1.5 text-[11px] text-muted hover:bg-raised hover:text-ink"
            >
              Show {lines.length - visible.length} more lines
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

const DiffRow = memo(function DiffRow({ line }: { line: DiffLine }) {
  if (line.type === 'meta') {
    return (
      <tr className="bg-sunken">
        <td colSpan={3} className="px-3 py-0.5 text-subtle">
          {line.text}
        </td>
      </tr>
    );
  }

  if (line.type === 'hunk') {
    return (
      <tr className="bg-info-soft/40">
        <td colSpan={3} className="px-3 py-0.5 text-info">
          {line.text}
        </td>
      </tr>
    );
  }

  return (
    <tr
      className={cn(
        line.type === 'add' && 'diff-line-add',
        line.type === 'remove' && 'diff-line-remove',
      )}
    >
      {/* `select-none` so copying a diff yields code, not line numbers. */}
      <td className="w-10 select-none border-r border-line px-2 text-right align-top text-subtle tabular-nums">
        {line.oldLine ?? ''}
      </td>
      <td className="w-10 select-none border-r border-line px-2 text-right align-top text-subtle tabular-nums">
        {line.newLine ?? ''}
      </td>
      <td className="whitespace-pre px-3 align-top text-ink">
        {/*
          Not `aria-hidden`. The row's only other add/remove signal is the
          `diff-line-add` / `diff-line-remove` class pair, which is pure colour —
          the table has no caption, no headers and no roles, and the line-number
          columns are unlabelled — so hiding the sign leaves nothing textual to
          distinguish an added line from a removed one in browse mode.
          `select-none` is what keeps a copied diff free of the signs; the two
          are independent.
        */}
        <span className="select-none text-subtle">
          {line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}
        </span>
        {line.text}
      </td>
    </tr>
  );
});
