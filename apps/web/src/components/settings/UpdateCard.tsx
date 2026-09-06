/**
 * The Updates card: check, and — where the host installed the updater — apply.
 *
 * Applying hands a version to the host's updater unit and nothing more; the
 * pull, the switch, the health gate and the automatic rollback are the same
 * deploy path CI uses. The container this page is served from is replaced
 * mid-flight, so the card expects to lose the server for a while: it keeps
 * polling through the gap and reloads itself once the new version answers.
 */

import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowUpCircle, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/ui/Modal';
import { Badge, Button, Card, CardHeader, QUIET_LINK, Spinner } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';
import { api, ApiError } from '@/lib/api';
import { nextUpdateWatch, type UpdateWatch } from '@/lib/update-watch';
import { Trans, useT } from '@/lib/i18n';

export function UpdateCard() {
  const t = useT();
  const updateQuery = useQuery({
    queryKey: ['update-check'],
    // Forced past the server's hour-long cache on purpose: with
    // `enabled: false` this only ever runs when a person presses Check, and
    // a deliberate press that gets last hour's answer reads as "no update"
    // minutes after one was published — which is how it shipped, and how it
    // was caught. Passive readers (the doctor) still enjoy the cache.
    queryFn: () => api.updateCheck(true),
    enabled: false,
  });
  const applyStatus = useQuery({
    queryKey: ['update-apply'],
    queryFn: () => api.updateApplyStatus(),
    // While a deploy is in flight the server goes away and comes back; keep
    // asking through the gap — the last data stands in during errors.
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state === 'requested' || state === 'running' ? 3000 : false;
    },
    retry: false,
  });

  const [confirming, setConfirming] = useState(false);
  const apply = useMutation({
    mutationFn: (version: string) => api.applyUpdate(version),
    onSuccess: () => void applyStatus.refetch(),
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t(
        'The update could not be requested.',
      )),
  });

  const result = updateQuery.data;
  // The endpoint answers { disabled: true } when the check is switched off;
  // everything past the banner works on the narrowed shape.
  const check = result && !('disabled' in result) ? result : null;
  const status = applyStatus.data;
  const applying = status?.state === 'requested' || status?.state === 'running';

  // The transition rule lives in nextUpdateWatch (tested pure): only a
  // success this page watched happen triggers the reload — status.json
  // survives across deploys, so "succeeded" alone may be old news.
  const watch = useRef<UpdateWatch>({ sawInFlight: false, reload: false });
  useEffect(() => {
    watch.current = nextUpdateWatch(watch.current, status?.state);
    if (watch.current.reload) {
      toast.success(t('Updated to {version} — reloading…', {
        version: status?.version ?? t('the new version'),
      }));
      const timer = setTimeout(() => window.location.reload(), 1500);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [status?.state, status?.version]);

  const canApply =
    status?.available === true && check?.updateAvailable === true && check.latest !== null && !applying;

  return (
    <Card>
      <CardHeader
        title={t('Updates')}
        description={t(
          'Compares this version against the latest published release. Applying runs the same health-gated, auto-rolling-back deploy as CI.',
        )}
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              loading={updateQuery.isFetching}
              onClick={() => void updateQuery.refetch()}
            >
              {t('Check')}
            </Button>
            {canApply ? (
              <Button variant="primary" size="sm" onClick={() => setConfirming(true)}>
                <ArrowUpCircle className="size-3.5" aria-hidden />
                {t('Apply')} {check?.latest}
              </Button>
            ) : null}
          </div>
        }
      />
      <div className="space-y-2 px-4 pb-4 text-[12.5px]">
        {!result ? (
          <p className="text-subtle">{t('Not checked yet.')}</p>
        ) : 'disabled' in result ? (
          <p className="text-muted">{t('The update check is switched off for this deployment.')}</p>
        ) : result.error ? (
          <p className="text-muted">
            {t('No release visible:')} <span className="font-mono">{result.error}</span>
          </p>
        ) : result.updateAvailable === true ? (
          <p className="text-ink">
            <Badge tone="warning" className="mr-2">
              {t('update')}
            </Badge>
            {t('{latest} is published; this server runs {current}.', {
              latest: result.latest ?? '',
              current: result.current,
            })}{' '}
            {result.releaseUrl ? (
              <a
                className={cn('underline', QUIET_LINK)}
                href={result.releaseUrl}
                target="_blank"
                rel="noreferrer"
              >
                {t('Release notes')}
              </a>
            ) : null}
          </p>
        ) : result.updateAvailable === false ? (
          <p className="text-muted">
            {t('Up to date — {current} is the latest release.', { current: result.current })}
          </p>
        ) : (
          <p className="text-muted">
            {t('The latest tag ({latest}) is not a version, so no comparison is possible.', {
              latest: result.latest ?? t('none'),
            })}
          </p>
        )}

        {applying ? (
          <p className="flex items-center gap-2 text-ink" role="status">
            <Spinner className="size-3.5" />
            {t(
              'Updating to {version} — the app restarts during this; the page reconnects and reloads itself.',
              { version: status?.version ?? '…' },
            )}
          </p>
        ) : status?.state === 'failed' ? (
          <p className="flex items-start gap-2 text-[12px] text-warning">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>
              {/* The version and the reason are both optional, so the sentence
                  is one template with two slots rather than three concatenated
                  pieces — French puts them in a different order. */}
              {t('The last update{version} did not go healthy{reason}', {
                version: status.version ? ` (${status.version})` : '',
                reason: status.message ? ` — ${status.message}` : '.',
              })}
            </span>
          </p>
        ) : null}

        {check?.updateAvailable === true && status?.available === false ? (
          <p className="text-[12px] text-muted">
            <Trans
              template={t(
                'Applying from here needs the host updater — re-run {script} on the server to add it.',
              )}
              values={{ script: <code>deploy/install-app.sh</code> }}
            />
          </p>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('Update to {version}?', { version: check?.latest ?? '' })}
        description={
          <>
            {t(
              'The server pulls the new image, restarts, and must pass the health gate — otherwise it rolls back to the current version by itself. Runs in flight are interrupted, and this page will lose the server for a minute before reloading on the new version.',
            )}
          </>
        }
        confirmLabel={t('Update now')}
        onConfirm={() => {
          if (check?.latest) apply.mutate(check.latest);
        }}
      />
    </Card>
  );
}
