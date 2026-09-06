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
import { Section } from '@/components/ui/layout';
import { Badge, Button, Card, EmptyState, Spinner } from '@/components/ui/primitives';
import { cn, formatRelative } from '@/lib/utils';
import { McpToolList } from './McpToolList';
import { useT } from '@/lib/i18n';

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

/**
 * Human names for the questions the CLI can decline to answer.
 *
 * Translated at render — the table is module-level, where no hook can run.
 * They used to be interpolated straight into a French sentence, which read as
 * "Ce CLI n'a pas pu répondre sur models, slash commands", and no i18n ratchet
 * saw it: all five begin with a lowercase letter, and the measures skip those
 * to avoid drowning in Tailwind class strings.
 */
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
  const t = useT();
  if (loading || !catalogue) {
    return (
      <div className="flex justify-center py-12" role="status" aria-label={t(
        'Reading what Claude offers',
      )}>
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
          <h2 className="text-title font-semibold text-ink">{t('What Claude offers here')}</h2>
          <p className="text-caption text-muted">
            {t('Read from the CLI itself')} {formatRelative(catalogue.fetchedAt)}
          </p>
          {/* Which account the CLI is actually signed in as. Metaclaude can
              hold credentials without ever saying whose, and "my subscription
              is not being used" looks identical to "my subscription is
              exhausted" until you can see this. Every field is optional on the
              wire, so the parts are joined rather than templated — otherwise a
              missing one leaves a separator with nothing after it. */}
          {catalogue.account ? (
            <p className="text-caption text-muted">
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
          {t('Refresh')}
        </Button>
      </div>

      {noSession ? (
        <Card>
          <EmptyState
            icon={<AlertTriangle />}
            title={t('The Claude CLI could not be reached')}
            description={t(
              'Metaclaude could not start a CLI session to ask. That usually means the binary is not on PATH inside the container, or no credentials are paired yet — check Settings.',
            )}
          />
        </Card>
      ) : null}

      {missing.length > 0 ? (
        <p className="rounded-lg bg-warning-soft px-3 py-2 text-caption leading-relaxed text-ink">
          {t(
            'This CLI could not answer about {questions}. Those sections are empty because the question failed, not because there is nothing there.',
            {
              questions: missing
                .map((name) => {
                  const known = QUESTION_NAMES[name];
                  return known ? t(known) : name;
                })
                .join(', '),
            },
          )}
        </p>
      ) : null}

      {/* MCP first: the only part of this screen that can be wrong right now. */}
      <CatalogueSection
        icon={<Server className="size-4 text-info" />}
        title={t('MCP servers')}
        subtitle={t(
          "The servers this workspace's runs mount — and whether each actually connected",
        )}
        count={catalogue.mcpServers.length}
      >
        {catalogue.mcpServers.map((server) => (
          <McpRow key={server.name} server={server} />
        ))}
      </CatalogueSection>
      <p className="rounded-lg border border-dashed border-line px-3 py-2 text-caption leading-relaxed text-subtle">
        {t(
          'Connectors from your claude.ai account never appear here: a server paired with a setup token authenticates for inference only, so the CLI cannot fetch them. To connect an external service, add its MCP server on the Agents screen — it is mounted into every run and reported above. Metaclaude’s own board and delegation tools ride along in-process and are always available.',
        )}
      </p>

      <CatalogueSection
        icon={<Wand2 className="size-4 text-accent" />}
        title={t('Models')}
        subtitle={t('What this subscription grants, and which take an effort level')}
        count={catalogue.models.length}
      >
        {catalogue.models.map((model) => (
          <CatalogueRow
            key={model.value}
            name={model.displayName || model.value}
            description={model.description}
            meta={
              <>
                <code className="font-mono text-caption text-subtle">{model.value}</code>
                {model.resolvedModel ? (
                  <code className="font-mono text-caption text-subtle">{model.resolvedModel}</code>
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
      </CatalogueSection>

      <CatalogueSection
        icon={<SlashSquare className="size-4 text-accent" />}
        title={t('Slash commands')}
        subtitle={t('Built in, plus anything this workspace defines')}
        count={catalogue.commands.length}
      >
        {catalogue.commands.map((command) => (
          <CatalogueRow
            key={command.name}
            name={`/${command.name}`}
            mono
            description={command.description}
            meta={
              command.argumentHint ? (
                <code className="font-mono text-caption text-subtle">{command.argumentHint}</code>
              ) : null
            }
          />
        ))}
      </CatalogueSection>

      <CatalogueSection
        icon={<Bot className="size-4 text-accent" />}
        title={t('Subagents')}
        subtitle={t('Named agents the CLI can delegate to')}
        count={catalogue.agents.length}
      >
        {catalogue.agents.map((agent) => (
          <CatalogueRow
            key={agent.name}
            name={agent.name}
            mono
            description={agent.description}
            meta={agent.model ? <Badge tone="neutral">{agent.model}</Badge> : null}
          />
        ))}
      </CatalogueSection>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * One shelf of the catalogue.
 *
 * The header — icon, title, subtitle, count, rule — was written by hand here
 * and is exactly what `Section` is for, so it delegates. What stays local is
 * the one thing that is not layout: a shelf reporting nothing says so rather
 * than showing an empty space, and every shelf can be empty.
 *
 * `level={3}`: this sits inside a tab panel, under the page's own heading.
 */
function CatalogueSection({
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
  const t = useT();
  return (
    <Section
      level={3}
      icon={icon}
      title={title}
      description={subtitle}
      actions={<span className="text-caption tabular-nums text-subtle">{count}</span>}
    >
      {count === 0 ? (
        <p className="rounded-lg border border-dashed border-line px-3 py-3 text-caption text-subtle">
          {t('Nothing reported.')}
        </p>
      ) : (
        <div className="space-y-1.5">{children}</div>
      )}
    </Section>
  );
}

function CatalogueRow({
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
          'shrink-0 text-body font-medium text-ink',
          mono && 'font-mono text-caption',
        )}
      >
        {name}
      </span>
      {description ? (
        <span className="min-w-0 flex-1 text-caption leading-relaxed text-muted">{description}</span>
      ) : (
        <span className="flex-1" />
      )}
      {meta ? <span className="flex flex-wrap items-center gap-1.5">{meta}</span> : null}
    </Card>
  );
}

function McpRow({ server }: { server: ClaudeMcpServerStatus }) {
  const t = useT();
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
        <code className="font-mono text-body font-medium text-ink">{server.name}</code>
        <Badge tone={status.tone}>
          {status.icon}
          {t(status.label)}
        </Badge>
        {server.serverName ? (
          <span className="text-caption text-subtle">
            {server.serverName}
            {server.serverVersion ? ` ${server.serverVersion}` : ''}
          </span>
        ) : null}
        {server.scope ? <Badge tone="neutral">{server.scope}</Badge> : null}
      </div>

      {server.error ? (
        <p className="break-words rounded-md bg-danger-soft/60 px-2.5 py-1.5 font-mono text-caption leading-relaxed text-ink">
          {server.error}
        </p>
      ) : null}

      {/* Was a row of chips whose descriptions lived in a `title` attribute —
          text that does not exist on a phone. Same data, rendered. */}
      <McpToolList tools={server.tools} />
    </Card>
  );
}
