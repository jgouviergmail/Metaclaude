/**
 * The machine.
 *
 * Version, uptime, timezone, CPU/RAM/disk, the Claude CLI and its credentials,
 * notifications, the doctor and the updater. It was a tab inside Settings,
 * which was wrong twice: nothing here is a preference — it is what the
 * deployment *is* — and "System" then named both that tab and the rail section
 * beside it. It is the first screen of the System section now, ahead of the
 * automations, because "is the box healthy" comes before "what is it doing".
 *
 * The cards are unchanged; only their address is.
 */

import { useQuery } from '@tanstack/react-query';
import { AppShell, ContentHeader } from '@/components/layout/AppShell';
import { SettingsTabs } from '@/components/layout/SettingsTabs';
import { Page, Section } from '@/components/ui/layout';
import { DoctorReportView } from '@/components/system/DoctorReportView';
import { ResourceMeters } from '@/components/system/ResourceMeters';
import { RetrievalStatus } from '@/components/system/RetrievalStatus';
import { ClaudeCredentialCard } from '@/components/settings/ClaudeCredentialCard';
import { NotificationsCard } from '@/components/settings/NotificationsCard';
import { UpdateCard } from '@/components/settings/UpdateCard';
import { Badge, Button, Spinner, StatList } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { useAuthStore } from '@/lib/store';
import { formatDuration } from '@/lib/utils';

export function ServerPage() {
  const t = useT();
  const user = useAuthStore((state) => state.user);

  return (
    <AppShell>
      <ContentHeader
        tabs={<SettingsTabs />}
        title={t('Server')}
        subtitle={t('What this deployment is running on.')}
      />
      <Page width="prose">
        <SystemCard />
        {user?.role === 'owner' ? <DoctorCard /> : null}
        {user?.role === 'owner' ? <UpdateCard /> : null}
      </Page>
    </AppShell>
  );
}

/**
 * On demand rather than on mount: a full examination probes the CLI binary
 * and walks the audit chain, and running that on every tab visit would be
 * noise. The button is the request.
 */
function DoctorCard() {
  const t = useT();
  const doctorQuery = useQuery({
    queryKey: ['doctor'],
    queryFn: () => api.doctor(),
    enabled: false,
  });

  return (
    <Section
      title={t('Doctor')}
      description={t(
        'Every self-check the system knows how to run — database, audit chain, vault, disk, CLI, automations.',
      )}
      actions={
        <Button
          variant="secondary"
          size="sm"
          loading={doctorQuery.isFetching}
          onClick={() => void doctorQuery.refetch()}
        >
          {t('Run checks')}
        </Button>
      }
    >
      <div>
        {doctorQuery.data ? (
          <DoctorReportView report={doctorQuery.data} />
        ) : doctorQuery.isError ? (
          <p className="text-caption text-muted">{t('The examination could not run.')}</p>
        ) : (
          <p className="text-caption text-subtle">{t('Not run yet.')}</p>
        )}
      </div>
    </Section>
  );
}
function SystemCard() {
  const t = useT();
  const { data, isLoading } = useQuery({
    queryKey: ['system'],
    queryFn: () => api.system(),
    refetchInterval: 30_000,
  });

  if (isLoading || !data) {
    return (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/*
        * Three facts, listed rather than tiled.
        *
        * Three big-number tiles in a two-column grid leave one orphaned on its
        * own row, and none of the three is a number worth a 24px display face
        * — a version string, an uptime and a timezone are things you look up,
        * not figures you monitor. `Stat` stays where the dashboard uses it,
        * for what actually moves.
        */}
      <Section title={t('Deployment')}>
        <StatList
          items={[
            { label: t('Version'), value: data.version },
            { label: t('Uptime'), value: formatDuration(data.uptimeMs) },
            {
              // The clock every cron expression is read in. A schedule typed
              // for eight on a UTC host fired at ten in Paris, and nothing
              // said which.
              label: t('Server timezone'),
              value: data.timezone,
              hint: t('Cron schedules are read in it.'),
            },
          ]}
        />
      </Section>
      {/* The same three meters the dashboard shows, from the same payload.
          Two separate renderings of "how full is the disk" would eventually
          disagree, and the one nobody is looking at would be the wrong one. */}
      <ResourceMeters resources={data.resources} />

      <Section
        title={t('Claude CLI')}
        description={t('Every agent run goes through this binary.')}
      >
        <dl className="divide-y divide-line">
          <DefinitionRow label={t('Available')}>
            {data.claudeCli.available ? (
              <Badge tone="success">{t('yes')}</Badge>
            ) : (
              <Badge tone="danger">{t('not found')}</Badge>
            )}
          </DefinitionRow>
          <DefinitionRow label={t('Version')}>{data.claudeCli.version ?? '—'}</DefinitionRow>
          <DefinitionRow label={t('Authentication')}>
            <div className="flex flex-wrap items-center gap-2">
              {data.claudeCli.authMode === 'subscription' ? (
                <Badge tone="success">{t('subscription (Pro / Max)')}</Badge>
              ) : data.claudeCli.authMode === 'api_key' ? (
                <Badge tone="warning">{t('API key (pay as you go)')}</Badge>
              ) : (
                <Badge tone="danger">{t('none configured')}</Badge>
              )}
              {data.claudeCli.authHint ? (
                <code className="font-mono text-caption text-muted">{data.claudeCli.authHint}</code>
              ) : null}
              {data.claudeCli.authSource ? (
                <span className="text-caption text-subtle">
                  {data.claudeCli.authSource === 'stored'
                    ? t('paired here')
                    : data.claudeCli.authSource === 'cli-login'
                      ? t('CLI account sign-in')
                      : t('from the environment')}
                </span>
              ) : null}
            </div>
          </DefinitionRow>
        </dl>
      </Section>

      <ClaudeCredentialCard />

      <NotificationsCard />

      <Section title={t('Kernel')}>
        <dl className="divide-y divide-line">
          <DefinitionRow label={t('Active runs')}>{data.activeRuns}</DefinitionRow>
          <DefinitionRow label={t('Queued runs')}>{data.queuedRuns}</DefinitionRow>
          <DefinitionRow label={t('Stored memories')}>{data.memoryCount}</DefinitionRow>
          <DefinitionRow label={t('Retrieval')}>
            <RetrievalStatus status={data.retrieval} />
          </DefinitionRow>
        </dl>
      </Section>
    </div>
  );
}
function DefinitionRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <dt className="text-body text-muted">{label}</dt>
      <dd className="text-body font-medium text-ink">{children}</dd>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Audit                                                                       */
/* -------------------------------------------------------------------------- */
