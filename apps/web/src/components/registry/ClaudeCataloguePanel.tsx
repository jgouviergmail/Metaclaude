/**
 * What Claude itself offers in this workspace.
 *
 * Everything on this screen used to be either hard-coded or invisible.
 * Metaclaude described the models from a list written when the page was built,
 * and it could configure an MCP server without ever saying whether the server
 * had actually connected — so a mistyped command looked exactly like an agent
 * ignoring its tools.
 *
 * The CLI knows all of it, and the answer is per-workspace: skills, subagents
 * and MCP servers are discovered relative to the directory a run happens in.
 *
 * MCP status leads the panel because it is the only part that can be *wrong*
 * right now. The rest is reference; a failed server is a task.
 */

import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clock,
  KeyRound,
  RefreshCw,
  Server,
  SlashSquare,
  Sparkles,
  Wand2,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type { ClaudeCatalogue, ClaudeMcpServerStatus } from '@metaclaude/shared';
import { Badge, Button, Card, EmptyState, Spinner } from '@/components/ui/primitives';
import { cn, formatRelative } from '@/lib/utils';

/** How each MCP status reads, and what it means the operator should do. */
const MCP_STATUS: Record<
  ClaudeMcpServerStatus['status'],
  { label: string; tone: 'success' | 'danger' | 'warning' | 'neutral'; icon: ReactNode }
> = {
  connected: { label: 'connected', tone: 'success', icon: <CheckCircle2 className="size-3.5" /> },
  failed: { label: 'failed', tone: 'danger', icon: <AlertTriangle className="size-3.5" /> },
  // Deliberately distinct from `failed`: the remedy is a consent flow nobody
  // has completed, not a configuration mistake.
  'needs-auth': { label: 'needs auth', tone: 'warning', icon: <KeyRound className="size-3.5" /> },
  pending: { label: 'connecting', tone: 'neutral', icon: <Clock className="size-3.5" /> },
  disabled: { label: 'disabled', tone: 'neutral', icon: <Clock className="size-3.5" /> },
  unknown: { label: 'unknown', tone: 'neutral', icon: <Clock className="size-3.5" /> },
};

/** Human names for the questions the CLI can decline to answer. */
const QUESTION_NAMES: Record<string, string> = {
  models: 'models',
  commands: 'slash commands',
  agents: 'subagents',
  mcpServers: 'MCP servers',
  account: 'account details',
};

export interface ClaudeCataloguePanelProps {
  catalogue: ClaudeCatalogue | undefined;
  loading: boolean;
  onRefresh: () => void;
}

export function ClaudeCataloguePanel({ catalogue, loading, onRefresh }: ClaudeCataloguePanelProps) {
  if (loading || !catalogue) {
    return (
      <div className="flex justify-center py-12" role="status" aria-label="Reading what Claude offers">
        <Spinner className="size-5" />
      </div>
    );
  }

  // The CLI could not be started at all — no binary on PATH, no credentials.
  // Distinct from any individual question failing, and the only case where
  // there is nothing else on the screen worth showing.
  const noSession = catalogue.unavailable.includes('session');
  const missing = catalogue.unavailable.filter((name) => name !== 'session');

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold text-ink">What Claude offers here</h2>
          <p className="text-[12.5px] text-muted">
            Read from the CLI itself {formatRelative(catalogue.fetchedAt)}
          </p>
          {/* Which account the CLI is actually signed in as. Metaclaude can
              hold credentials without ever saying whose, and "my subscription
              is not being used" looks identical to "my subscription is
              exhausted" until you can see this. Every field is optional on the
              wire, so the parts are joined rather than templated — otherwise a
              missing one leaves a separator with nothing after it. */}
          {catalogue.account ? (
            <p className="text-[12.5px] text-muted">
              {[
                catalogue.account.email,
                catalogue.account.organization,
                catalogue.account.subscriptionType
                  ? `${catalogue.account.subscriptionType} subscription`
                  : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          ) : null}
        </div>
        <Button variant="secondary" size="sm" onClick={onRefresh}>
          <RefreshCw className="size-3.5" />
          Refresh
        </Button>
      </div>

      {noSession ? (
        <Card>
          <EmptyState
            icon={<AlertTriangle />}
            title="The Claude CLI could not be reached"
            description="Metaclaude could not start a CLI session to ask. That usually means the binary is not on PATH inside the container, or no credentials are paired yet — check Settings."
          />
        </Card>
      ) : null}

      {missing.length > 0 ? (
        <p className="rounded-lg bg-warning-soft px-3 py-2 text-[12.5px] leading-relaxed text-ink">
          This CLI could not answer about{' '}
          {missing.map((name) => QUESTION_NAMES[name] ?? name).join(', ')}. Those sections are empty
          because the question failed, not because there is nothing there.
        </p>
      ) : null}

      {/* MCP first: the only part of this screen that can be wrong right now. */}
      <Section
        icon={<Server className="size-4 text-info" />}
        title="MCP servers"
        subtitle="Whether each configured server actually connected"
        count={catalogue.mcpServers.length}
      >
        {catalogue.mcpServers.map((server) => (
          <McpRow key={server.name} server={server} />
        ))}
      </Section>

      <Section
        icon={<Wand2 className="size-4 text-accent" />}
        title="Models"
        subtitle="What this subscription grants, and which take an effort level"
        count={catalogue.models.length}
      >
        {catalogue.models.map((model) => (
          <Row
            key={model.value}
            name={model.displayName || model.value}
            description={model.description}
            meta={
              <>
                <code className="font-mono text-[11.5px] text-subtle">{model.value}</code>
                {model.resolvedModel ? (
                  <code className="font-mono text-[11.5px] text-subtle">{model.resolvedModel}</code>
                ) : null}
                {model.supportedEffortLevels.map((level) => (
                  <Badge key={level} tone="neutral">
                    {level}
                  </Badge>
                ))}
              </>
            }
          />
        ))}
      </Section>

      <Section
        icon={<SlashSquare className="size-4 text-accent" />}
        title="Slash commands"
        subtitle="Built in, plus anything this workspace defines"
        count={catalogue.commands.length}
      >
        {catalogue.commands.map((command) => (
          <Row
            key={command.name}
            name={`/${command.name}`}
            mono
            description={command.description}
            meta={
              command.argumentHint ? (
                <code className="font-mono text-[11.5px] text-subtle">{command.argumentHint}</code>
              ) : null
            }
          />
        ))}
      </Section>

      <Section
        icon={<Bot className="size-4 text-accent" />}
        title="Subagents"
        subtitle="Named agents the CLI can delegate to"
        count={catalogue.agents.length}
      >
        {catalogue.agents.map((agent) => (
          <Row
            key={agent.name}
            name={agent.name}
            mono
            description={agent.description}
            meta={agent.model ? <Badge tone="neutral">{agent.model}</Badge> : null}
          />
        ))}
      </Section>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function Section({
  icon,
  title,
  subtitle,
  count,
  children,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-2">
        <span className="translate-y-0.5">{icon}</span>
        <h3 className="text-[13.5px] font-semibold text-ink">{title}</h3>
        <span className="text-[11.5px] tabular-nums text-subtle">{count}</span>
      </div>
      <p className="text-[12px] text-muted">{subtitle}</p>
      {count === 0 ? (
        <p className="rounded-lg border border-dashed border-line px-3 py-3 text-[12.5px] text-subtle">
          Nothing reported.
        </p>
      ) : (
        <div className="space-y-1.5">{children}</div>
      )}
    </section>
  );
}

function Row({
  name,
  description,
  meta,
  mono,
}: {
  name: string;
  description?: string;
  meta?: ReactNode;
  mono?: boolean;
}) {
  return (
    <Card className="flex flex-col gap-1 p-3 sm:flex-row sm:items-baseline sm:gap-3">
      <span
        className={cn(
          'shrink-0 text-[13px] font-medium text-ink',
          mono && 'font-mono text-[12.5px]',
        )}
      >
        {name}
      </span>
      {description ? (
        <span className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-muted">{description}</span>
      ) : (
        <span className="flex-1" />
      )}
      {meta ? <span className="flex flex-wrap items-center gap-1.5">{meta}</span> : null}
    </Card>
  );
}

function McpRow({ server }: { server: ClaudeMcpServerStatus }) {
  const status = MCP_STATUS[server.status];
  const broken = server.status === 'failed';

  return (
    <Card
      // A failed server is a task, not a row. Announcing it is what gets it
      // fixed rather than scrolled past.
      role={broken ? 'alert' : undefined}
      className={cn('space-y-2 p-3', broken && 'border-danger/30 bg-danger-soft/30')}
    >
      <div className="flex flex-wrap items-center gap-2">
        <code className="font-mono text-[13px] font-medium text-ink">{server.name}</code>
        <Badge tone={status.tone}>
          {status.icon}
          {status.label}
        </Badge>
        {server.serverName ? (
          <span className="text-[11.5px] text-subtle">
            {server.serverName}
            {server.serverVersion ? ` ${server.serverVersion}` : ''}
          </span>
        ) : null}
        {server.scope ? <Badge tone="neutral">{server.scope}</Badge> : null}
      </div>

      {server.error ? (
        <p className="break-words rounded-md bg-danger-soft/60 px-2.5 py-1.5 font-mono text-[11.5px] leading-relaxed text-ink">
          {server.error}
        </p>
      ) : null}

      {server.tools.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {server.tools.map((tool) => (
            <span
              key={tool.name}
              title={tool.description}
              className={cn(
                'inline-flex items-center gap-1 rounded-md border border-line px-1.5 py-0.5',
                'font-mono text-[11px] text-muted',
              )}
            >
              {/* The server's own advertised hints. Displayed to inform the
                  operator, never used to decide anything — a server that
                  mislabels a destructive tool must not be trusted by that. */}
              {tool.destructive ? (
                <AlertTriangle className="size-3 text-warning" aria-label="destructive" />
              ) : tool.readOnly ? (
                <Sparkles className="size-3 text-success" aria-label="read-only" />
              ) : null}
              {tool.name}
            </span>
          ))}
        </div>
      ) : null}
    </Card>
  );
}
