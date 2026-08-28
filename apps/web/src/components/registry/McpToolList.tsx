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

export function McpToolList({
  tools,
  defaultOpen = false,
}: {
  tools: ClaudeMcpServerStatus['tools'];
  defaultOpen?: boolean;
}) {
  const t = useT();
  const plural = usePlural();

  if (tools.length === 0) return null;

  return (
    <details className="group rounded-lg border border-line bg-sunken/40" open={defaultOpen}>
      <summary
        className="flex cursor-pointer list-none items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <ChevronRight
          className="size-3.5 shrink-0 transition-transform group-open:rotate-90"
          aria-hidden
        />
        {plural(tools.length, '{n} tool exposed', '{n} tools exposed')}
      </summary>

      <ul className="space-y-1.5 border-t border-line px-2.5 py-2">
        {tools.map((tool) => (
          <li key={tool.name} className="space-y-0.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <code className="break-all font-mono text-[11.5px] text-ink">{tool.name}</code>
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
              <p className="text-[11.5px] leading-relaxed text-muted">{tool.description}</p>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}
