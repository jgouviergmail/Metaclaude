/**
 * What every agent run authenticates through, as the server sees it.
 *
 * A reading, not a control: the binary is pinned into the image and the
 * credential is set by the card below this one. What this answers is the
 * question an owner asks first when nothing runs — is the CLI there, which
 * version, and what is it authenticating with.
 *
 * It moved here from the Server screen with the credential card it explains.
 * The two were three sections apart on a screen about the machine, and reading
 * one without the other is how "authentication: none configured" becomes a
 * puzzle rather than a sentence: this says what is in force, the card below
 * changes it.
 *
 * Its own query rather than a prop, because it is now rendered from a screen
 * that has no reason to fetch the system health. React Query shares the
 * `['system']` key with the Server screen, so nothing is fetched twice when
 * both are open in one session.
 */

import { useQuery } from '@tanstack/react-query';
import { Section } from '@/components/ui/layout';
import { Badge, Spinner } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';

export function ClaudeCliCard() {
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
    <Section title={t('Claude CLI')} description={t('Every agent run goes through this binary.')}>
      <dl className="divide-y divide-line">
        <Row label={t('Available')}>
          {data.claudeCli.available ? (
            <Badge tone="success">{t('yes')}</Badge>
          ) : (
            <Badge tone="danger">{t('not found')}</Badge>
          )}
        </Row>
        <Row label={t('Version')}>{data.claudeCli.version ?? '—'}</Row>
        <Row label={t('Authentication')}>
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
        </Row>
      </dl>
    </Section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <dt className="text-body text-muted">{label}</dt>
      <dd className="text-body font-medium text-ink">{children}</dd>
    </div>
  );
}
