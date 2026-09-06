/**
 * Push notifications, per device.
 *
 * The state that matters is *this browser's*: the server can hold five
 * subscriptions and this phone still be deaf. So the card leads with the
 * device it is rendered on — enabled, or not, or incapable — and treats the
 * deployment-wide device count as the secondary fact. The test button exists
 * because "enabled" and "actually reaching the lock screen" are different
 * claims, and only one of them convinces.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { usePlural, useT } from '@/lib/i18n';
import { Badge, Button, Card, CardHeader } from '@/components/ui/primitives';
import { api, ApiError } from '@/lib/api';
import { currentSubscription, disablePush, enablePush, pushSupported } from '@/lib/push';

export function NotificationsCard() {
  const plural = usePlural();
  const t = useT();
  const queryClient = useQueryClient();
  const supported = pushSupported();
  const [endpoint, setEndpoint] = useState<string | null>(null);

  const status = useQuery({
    queryKey: ['push-status'],
    queryFn: () => api.push.status(),
    enabled: supported,
  });

  useEffect(() => {
    if (!supported) return;
    void currentSubscription().then((subscription) => {
      setEndpoint(subscription?.endpoint ?? null);
      // The browser's subscription and the server's row drift apart — a
      // restored database, a registration that failed after the permission
      // was granted — and this card then claims "subscribed" from the
      // browser's half alone while the server has nothing to send to.
      // Re-registering is an idempotent upsert and needs no permission
      // prompt, so the two halves converge on every visit to this screen.
      if (subscription) {
        api.push.subscribe(subscription).catch(() => undefined);
      }
    });
  }, [supported]);

  const enable = useMutation({
    mutationFn: async () => {
      // Resolved here rather than read from the query: a tap that lands
      // before the status query settles must still work, not ask for a
      // reload — the whole card exists for a person on a phone.
      const { publicKey } = status.data ?? (await api.push.status());
      const subscription = await enablePush(publicKey);
      await api.push.subscribe(subscription);
      return subscription.endpoint;
    },
    onSuccess: (next) => {
      setEndpoint(next);
      void queryClient.invalidateQueries({ queryKey: ['push-status'] });
      toast.success(t('This device now receives notifications.'));
    },
    onError: (error) =>
      toast.error(
        error instanceof ApiError || error instanceof Error
          ? error.message
          : t('Could not enable notifications.'),
      ),
  });

  const disable = useMutation({
    mutationFn: async () => {
      const removed = await disablePush();
      if (removed) await api.push.unsubscribe(removed);
    },
    onSuccess: () => {
      setEndpoint(null);
      void queryClient.invalidateQueries({ queryKey: ['push-status'] });
      toast.success(t('This device will no longer be notified.'));
    },
  });

  const test = useMutation({
    mutationFn: () => api.push.test(),
    // Three different truths, three different sentences: delivered, nothing
    // to deliver to, and — the one that used to masquerade as "no device is
    // subscribed" — devices exist but every delivery failed.
    onSuccess: (outcome) => {
      if (outcome.sent > 0) {
        toast.success(plural(outcome.sent, 'Sent to {n} device.', 'Sent to {n} devices.'));
      } else if (outcome.devices === 0) {
        toast.success(t('No device is subscribed yet.'));
      } else {
        toast.error(
          plural(
            outcome.devices,
            '{n} device subscribed but the test could not be delivered{err}.',
            '{n} devices subscribed but the test could not be delivered{err}.',
            { err: outcome.lastError ? ` — ${outcome.lastError}` : '' },
          ),
        );
      }
    },
    onError: () => toast.error(t('The test notification could not be sent.')),
  });

  return (
    <Card>
      <CardHeader
        title={t('Notifications')}
        description={t(
          'A push when a run waits on your approval, and when a run you started ends. Automations stay silent by design.',
        )}
      />
      <div className="space-y-3 px-4 pb-4">
        {!supported ? (
          <p className="text-caption leading-relaxed text-muted">
            {t(
              'This browser cannot receive push notifications. On iPhone and iPad they need the app installed to the Home Screen (Share → Add to Home Screen), then enabled from here.',
            )}
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {endpoint ? (
                <>
                  <Badge tone="success">
                    <BellRing className="size-3" aria-hidden />
                    {t('this device is subscribed')}
                  </Badge>
                  <Button variant="secondary" size="sm" loading={test.isPending} onClick={() => test.mutate()}>
                    {t('Send a test')}
                  </Button>
                  <Button variant="ghost" size="sm" loading={disable.isPending} onClick={() => disable.mutate()}>
                    {t('Disable here')}
                  </Button>
                </>
              ) : (
                <Button
                  variant="primary"
                  size="sm"
                  loading={enable.isPending}
                  onClick={() => enable.mutate()}
                >
                  <BellRing className="size-3.5" aria-hidden />
                  {t('Enable on this device')}
                </Button>
              )}
            </div>
            <p className="text-caption text-subtle">
              {status.data
                ? plural(
                    status.data.devices,
                    '{n} device subscribed across the deployment.',
                    '{n} devices subscribed across the deployment.',
                  )
                : t('Reading the push status…')}{' '}
              {t('The app icon also shows a badge while approvals wait.')}
            </p>
          </>
        )}
      </div>
    </Card>
  );
}
