/**
 * The tools an MCP server actually exposes, as the CLI reports them.
 *
 * Two screens ask the same question — the catalogue panel, and the tab where
 * the servers are configured — so this is one component rather than two
 * renderings that would drift.
 *
 * Folded by default, and the descriptions are *rendered* rather than hidden in
 * a `title` attribute. The chips this replaces put each tool's description
 * there, which is invisible on a phone: there is no hover, and a decorative
 * `<span>` never takes focus, so the text existed only for a mouse. A server
 * with thirty tools is also a wall, hence the fold — but the count is on the
 * summary, so the fold never hides *whether* there is anything to see.
 */

import { AlertTriangle, ChevronRight, Eye } from 'lucide-react';
import type { ClaudeMcpServerStatus } from '@metaclaude/shared';
import { Badge } from '@/components/ui/primitives';
import { usePlural, useT } from '@/lib/i18n';
import { formatRelative } from '@/lib/utils';

export function McpToolList({
  tools,
  defaultOpen = false,
  learnedAt = null,
}: {
  tools: ClaudeMcpServerStatus['tools'];
  defaultOpen?: boolean;
  /**
   * When this list is a stored answer rather than a live reading.
   *
   * Null for the catalogue, which mounts what a run mounts and is therefore
   * current by construction. A stored list is what one test learned at one
   * moment, and a snapshot no reader can date is indistinguishable from a
   * claim about now — so it carries its own date, and says what refreshes it.
   */
  learnedAt?: number | null;
}) {
  const t = useT();
  const plural = usePlural();

  if (tools.length === 0) return null;

  return (
    <details className="group rounded-lg border border-line bg-sunken/40" open={defaultOpen}>
      <summary
        className="flex cursor-pointer list-none items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-caption text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <ChevronRight
          className="size-3.5 shrink-0 transition-transform group-open:rotate-90"
          aria-hidden
        />
        {plural(tools.length, '{n} tool exposed', '{n} tools exposed')}
        {learnedAt ? (
          <span className="text-caption text-muted/80">
            {t('· last test: {when}', { when: formatRelative(learnedAt) })}
          </span>
        ) : null}
      </summary>

      <ul className="space-y-1.5 border-t border-line px-2.5 py-2">
        {tools.map((tool) => (
          <li key={tool.name} className="space-y-0.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <code className="break-all font-mono text-caption text-ink">{tool.name}</code>
              {/* The server's own advertised hints. Shown to inform, never used
                  to decide anything — a server that mislabels a destructive
                  tool must not be trusted by that. */}
              {tool.destructive ? (
                <Badge tone="warning">
                  <AlertTriangle className="size-3" aria-hidden />
                  {t('destructive')}
                </Badge>
              ) : tool.readOnly ? (
                <Badge tone="success">
                  <Eye className="size-3" aria-hidden />
                  {t('read-only')}
                </Badge>
              ) : null}
            </div>
            {tool.description ? (
              <p className="text-caption leading-relaxed text-muted">{tool.description}</p>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}
