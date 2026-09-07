/**
 * Tool call card.
 *
 * A run is mostly tool calls, so this component decides how readable the whole
 * transcript feels. The rule it follows: show what the tool *did* in one line,
 * and keep the payload one click away. A wall of JSON is not observability.
 */

import {
  AlertTriangle,
  Check,
  ChevronRight,
  Circle,
  Copy,
  FileCode,
  FilePen,
  FilePlus,
  Globe,
  Loader2,
  Search,
  Sparkles,
  Terminal,
  X,
} from 'lucide-react';
import { memo, useState, type ReactNode } from 'react';
import type { TranscriptEvent } from '@metaclaude/shared';
import { Badge, Tooltip } from '@/components/ui/primitives';
import { cn, copyToClipboard, formatDuration, truncate } from '@/lib/utils';
import { useT } from '@/lib/i18n';

type ToolCall = Extract<TranscriptEvent, { kind: 'tool_call' }>;

/** Icon per tool. Unknown tools fall back to the generic MCP sparkle. */
function iconFor(name: string): ReactNode {
  switch (name.replace(/^mcp__[^_]+__/, '')) {
    case 'Bash':
      return <Terminal />;
    case 'Read':
      return <FileCode />;
    case 'Write':
      return <FilePlus />;
    case 'Edit':
    case 'NotebookEdit':
      return <FilePen />;
    case 'Glob':
    case 'Grep':
      return <Search />;
    case 'WebFetch':
    case 'WebSearch':
      return <Globe />;
    default:
      return <Sparkles />;
  }
}

/**
 * What each tool is called, and which of its inputs is worth the one line.
 *
 * A table rather than a switch, and English kept as *data*: the label is a
 * catalogue key that the component translates at render. A constant evaluated
 * at import time must never bake a language in.
 */
const TOOLS: Record<string, { label: string; field: string | null; path?: true }> = {
  Bash: { label: 'Terminal', field: 'command' },
  Read: { label: 'Read', field: 'file_path', path: true },
  Write: { label: 'Write', field: 'file_path', path: true },
  Edit: { label: 'Edit', field: 'file_path', path: true },
  Glob: { label: 'Find files', field: 'pattern' },
  Grep: { label: 'Search', field: 'pattern' },
  WebFetch: { label: 'Fetch', field: 'url' },
  WebSearch: { label: 'Web search', field: 'query' },
  Task: { label: 'Subagent', field: 'description' },
  TodoWrite: { label: 'Plan', field: null },
};

/**
 * One-line summary of what a tool call is doing.
 * Mirrors the server's `summarise`, but tuned for a narrow column.
 *
 * The label comes back untranslated — see `TOOLS`.
 */
function summarise(call: ToolCall): { label: string; detail: string | null } {
  const input = (call.input ?? {}) as Record<string, unknown>;
  const str = (key: string): string | null =>
    typeof input[key] === 'string' ? (input[key] as string) : null;

  const tool = TOOLS[call.name.replace(/^mcp__[^_]+__/, '')];
  // An MCP tool has no entry: its own name, with the server prefix made
  // readable, is the only honest label available.
  if (!tool) return { label: call.name.replace(/^mcp__([^_]+)__/, '$1: '), detail: null };

  const raw = tool.field === null ? null : str(tool.field);
  return { label: tool.label, detail: tool.path ? shortPath(raw) : raw };
}

/** Keep the last two path segments, which is what identifies a file at a glance. */
function shortPath(path: string | null): string | null {
  if (!path) return null;
  const parts = path.split('/').filter(Boolean);
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join('/')}`;
}

function StatusIcon({ status }: { status: ToolCall['status'] }) {
  switch (status) {
    case 'running':
      return <Loader2 className="size-3.5 shrink-0 animate-spin text-accent" />;
    case 'ok':
      return <Check className="size-3.5 shrink-0 text-success" />;
    case 'error':
      return <AlertTriangle className="size-3.5 shrink-0 text-danger" />;
    case 'denied':
      return <X className="size-3.5 shrink-0 text-warning" />;
    default:
      return <Circle className="size-3.5 shrink-0 text-subtle" />;
  }
}

export const ToolCallCard = memo(function ToolCallCard({
  call,
  defaultExpanded = false,
}: {
  call: ToolCall;
  defaultExpanded?: boolean;
}) {
  const t = useT();
  /*
   * Errors open by default: a failure the user has to click to see is a failure
   * they will miss.
   *
   * This has to be derived rather than seeded, because a tool call is emitted
   * twice under one event id — once as `running` when the `tool_use` block
   * arrives, once again when the result comes back. The store maps the second
   * into the same slot, and the stream keys on `event.id`, so React re-renders
   * this component rather than remounting it. A `useState` initialiser runs on
   * mount only, so `resultIsError` was read when it was still `false` and the
   * card never opened — the failing command's output was behind a click, and
   * toggling the "Expand tool calls" preference changed nothing already on
   * screen for the same reason.
   *
   * `null` means "the operator has not said", so a deliberate collapse of a
   * failed call still sticks.
   */
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  const expanded = userToggled ?? (defaultExpanded || call.resultIsError);
  const [copied, setCopied] = useState(false);

  // The labels are English *data* — a mapping table, not rendered copy — so
  // the translation happens here rather than inside a plain function where no
  // hook can run.
  const { label: labelKey, detail } = summarise(call);
  const label = t(labelKey);
  const isCommand = call.name.replace(/^mcp__[^_]+__/, '') === 'Bash';

  const copyPayload = async (): Promise<void> => {
    const text = JSON.stringify(call.input, null, 2);
    if (await copyToClipboard(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  };

  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border bg-surface transition-colors',
        call.resultIsError ? 'border-danger/35' : 'border-line',
      )}
    >
      <button
        type="button"
        onClick={() => setUserToggled(!expanded)}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-raised"
        aria-expanded={expanded}
      >
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-subtle transition-transform duration-150',
            expanded && 'rotate-90',
          )}
          aria-hidden
        />
        <span className="shrink-0 text-subtle [&>svg]:size-3.5" aria-hidden>
          {iconFor(call.name)}
        </span>

        <span className="shrink-0 text-body font-medium text-ink">{t(label)}</span>

        {detail ? (
          <code
            className={cn(
              'min-w-0 flex-1 truncate text-caption text-muted',
              isCommand && 'font-mono',
            )}
          >
            {detail}
          </code>
        ) : (
          <span className="flex-1" />
        )}

        {call.durationMs !== null && call.durationMs > 1500 ? (
          <span className="shrink-0 text-caption tabular-nums text-subtle">
            {formatDuration(call.durationMs)}
          </span>
        ) : null}

        <StatusIcon status={call.status} />
      </button>

      {expanded ? (
        <div className="space-y-3 border-t border-line bg-sunken px-3 py-3">
          <section>
            <div className="mb-1.5 flex items-center justify-between">
              <h4 className="text-eyebrow uppercase text-subtle">
                {t('Input')}
              </h4>
              <Tooltip content={copied ? 'Copied' : t('Copy input')}>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    void copyPayload();
                  }}
                  className="rounded p-1 text-subtle hover:bg-raised hover:text-ink"
                  aria-label={t('Copy tool input')}
                >
                  {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                </button>
              </Tooltip>
            </div>
            <pre className="max-h-64 overflow-auto rounded-md bg-surface p-2.5 font-mono text-caption leading-relaxed text-ink">
              {formatInput(call.input, isCommand)}
            </pre>
          </section>

          {call.result ? (
            <section>
              <h4 className="text-eyebrow mb-1.5 flex items-center gap-2 uppercase text-subtle">
                {t('Result')}
                {call.resultIsError ? <Badge tone="danger">{t('error')}</Badge> : null}
              </h4>
              <pre
                className={cn(
                  'max-h-80 overflow-auto rounded-md p-2.5 font-mono text-caption leading-relaxed',
                  call.resultIsError
                    ? 'bg-danger-soft text-ink'
                    : 'bg-surface text-ink',
                )}
              >
                {call.result}
              </pre>
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

/**
 * Render a tool's input for display.
 * A Bash command is shown as the raw command, not as JSON with escaped quotes —
 * that is the form the operator can actually read and verify.
 */
function formatInput(input: unknown, isCommand: boolean): string {
  if (isCommand && input && typeof input === 'object') {
    const record = input as Record<string, unknown>;
    if (typeof record.command === 'string') {
      const extras = Object.entries(record)
        .filter(([key]) => key !== 'command')
        .map(([key, value]) => `# ${key}: ${truncate(String(value), 120)}`);
      return [record.command, ...extras].join('\n');
    }
  }
  try {
    return JSON.stringify(input, null, 2) ?? String(input);
  } catch {
    return String(input);
  }
}
