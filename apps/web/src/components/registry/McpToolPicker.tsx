/**
 * Choosing which of an MCP server's tools a workspace pre-approves.
 *
 * A sibling of `McpToolList` rather than a mode of it, and the distinction is
 * the one that matters here: that component *informs* — it renders what a
 * server said it offers, on two screens that only look — while this one
 * *decides*, and every row it draws writes into a workspace's settings. Giving
 * the display component a checkbox would put a control on the catalogue panel,
 * which has nothing to save it to. What is shared is the shape of the fold,
 * deliberately: the same chevron, the same count on the summary, and the
 * descriptions rendered rather than hidden in a `title` nobody on a phone can
 * reach.
 *
 * Folded by default. An operator may have half a dozen servers of thirty tools
 * each, and this sits inside a dialog that already scrolls — but the count
 * rides on the summary, so folding never hides *whether* anything is ticked.
 *
 * Why it exists: under `Don't ask` the CLI refuses everything not
 * pre-approved, and the only thing the interface could ever tick was a closed
 * list of seven built-ins. A workspace with a working MCP server therefore had
 * no way to use it unattended, and nothing on the screen said why.
 */

import { ChevronRight, RefreshCw } from 'lucide-react';
import type { WorkspaceMcpServerTools } from '@metaclaude/shared';
import { CheckboxField } from '@/components/ui/controls';
import { Badge, Button } from '@/components/ui/primitives';
import { usePlural, useT } from '@/lib/i18n';

export function McpToolPicker({
  servers,
  selected,
  onChange,
  onDescribe,
  describing = null,
  disabled = false,
}: {
  servers: readonly WorkspaceMcpServerTools[];
  /** The workspace's whole pre-approval list, built-ins included. */
  selected: readonly string[];
  onChange: (next: string[]) => void;
  /** Ask a server what it offers, for one that has never been asked. */
  onDescribe: (serverId: string) => void;
  /** The server currently being asked, so its button can say so. */
  describing?: string | null;
  disabled?: boolean;
}) {
  const t = useT();
  const plural = usePlural();

  if (servers.length === 0) return null;

  /*
   * The whole list is replaced on every change rather than the entry toggled
   * in place, because the caller stores one array holding built-ins *and* MCP
   * names. Set arithmetic on that array keeps this component from having to
   * know which entries are not its own — it only ever adds or removes names it
   * was given, and anything else passes through untouched.
   */
  const withTools = (add: readonly string[], remove: readonly string[]): string[] => {
    const dropped = new Set(remove);
    const kept = selected.filter((name) => !dropped.has(name));
    return [...new Set([...kept, ...add])];
  };

  return (
    <div className="space-y-2">
      {servers.map((server) => {
        const names = server.tools.map((tool) => tool.qualified);
        const ticked = names.filter((name) => selected.includes(name));
        const busy = describing === server.id;

        return (
          <details key={server.id} className="group rounded-lg border border-line bg-sunken/40">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-lg px-2.5 py-2 text-caption text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
              <ChevronRight
                className="size-3.5 shrink-0 transition-transform group-open:rotate-90"
                aria-hidden
              />
              <code className="font-mono text-caption text-ink">{server.name}</code>
              {/* Which of these the operator configured, and which Metaclaude
                  provides. Without it `metaclaude` reads as a server they set
                  up and forgot, and its one tool is the widest here. */}
              {server.internal ? <Badge tone="neutral">{t('built in')}</Badge> : null}
              {/* The count is on the summary on purpose: the fold may hide the
                  rows, never whether this server decides anything. */}
              {ticked.length > 0 ? (
                <Badge tone="accent">
                  {t('{ticked} of {total}', {
                    ticked: String(ticked.length),
                    total: String(names.length),
                  })}
                </Badge>
              ) : (
                <span className="text-muted/80">
                  {server.tools.length === 0
                    ? t('tools unknown')
                    : plural(names.length, '{n} tool, none pre-approved', '{n} tools, none pre-approved')}
                </span>
              )}
            </summary>

            <div className="space-y-3 border-t border-line px-2.5 py-2.5">
              {server.tools.length === 0 ? (
                <div className="space-y-2">
                  <p className="text-caption leading-relaxed text-muted">
                    {t(
                      'Nobody has asked this server what it offers yet, so there is nothing to tick. Asking opens one connection to it.',
                    )}
                  </p>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={disabled || busy}
                    onClick={() => onDescribe(server.id)}
                  >
                    <RefreshCw className={busy ? 'size-3.5 animate-spin' : 'size-3.5'} aria-hidden />
                    {busy ? t('Asking…') : t('List its tools')}
                  </Button>
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={disabled || ticked.length === names.length}
                      onClick={() => onChange(withTools(names, []))}
                    >
                      {t('Tick all')}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={disabled || ticked.length === 0}
                      onClick={() => onChange(withTools([], names))}
                    >
                      {t('Untick all')}
                    </Button>
                  </div>

                  <div className="space-y-2.5">
                    {server.tools.map((tool) => (
                      <CheckboxField
                        key={tool.qualified}
                        disabled={disabled}
                        checked={selected.includes(tool.qualified)}
                        onChange={(on) =>
                          onChange(
                            on ? withTools([tool.qualified], []) : withTools([], [tool.qualified]),
                          )
                        }
                        // The bare name, because the qualified one is the same
                        // prefix repeated down the column and the server is
                        // already named on the summary above.
                        label={<code className="font-mono">{tool.bare}</code>}
                        hint={tool.description}
                      />
                    ))}
                  </div>
                </>
              )}
            </div>
          </details>
        );
      })}
    </div>
  );
}
