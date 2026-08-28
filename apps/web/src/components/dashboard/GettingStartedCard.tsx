/**
 * The getting-set-up card, on the dashboard until it has nothing to say.
 *
 * Owner-only, because every step it checks is an owner act; hidden the
 * moment every step is done, and dismissible for the owner who prefers to
 * find their own way — that choice sticks per browser, which is exactly
 * the durability a "stop showing me this" deserves.
 */

import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Circle, X } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { usePlural, useT } from '@/lib/i18n';
import { Button, Card, CardHeader } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { onboardingDone, onboardingSteps } from '@/lib/onboarding';
import { useAuthStore } from '@/lib/store';

const DISMISS_KEY = 'mc-getting-started-dismissed';

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

export function GettingStartedCard() {
  const plural = usePlural();
  const t = useT();
  const user = useAuthStore((state) => state.user);
  const [dismissed, setDismissed] = useState(readDismissed);
  const owner = user?.role === 'owner';

  const system = useQuery({
    queryKey: ['system'],
    queryFn: () => api.system(),
    enabled: owner && !dismissed,
  });
  const workspaces = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => api.workspaces(),
    enabled: owner && !dismissed,
  });
  const runs = useQuery({
    queryKey: ['runs', 'recent'],
    queryFn: () => api.runs({ limit: 1 }),
    enabled: owner && !dismissed,
  });
  const push = useQuery({
    queryKey: ['push-status'],
    queryFn: () => api.push.status(),
    enabled: owner && !dismissed,
  });
  const updater = useQuery({
    queryKey: ['update-apply'],
    queryFn: () => api.updateApplyStatus(),
    enabled: owner && !dismissed,
  });

  if (!owner || dismissed) return null;
  // Say nothing until the answers are in: a checklist that flashes
  // half-done while queries settle teaches people to ignore it.
  if (!system.data || !workspaces.data || !runs.data || !push.data || !updater.data) return null;

  const steps = onboardingSteps({
    authenticated: system.data.claudeCli.authenticated,
    workspaces: workspaces.data.workspaces.length,
    hasRuns: runs.data.runs.length > 0,
    totpEnabled: user?.totpEnabled ?? false,
    pushDevices: push.data.devices,
    updaterAvailable: updater.data.available,
  });
  if (onboardingDone(steps)) return null;

  const remaining = steps.filter((step) => !step.done).length;

  const dismiss = (): void => {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // A browser refusing storage still gets the session-long dismissal.
    }
    setDismissed(true);
  };

  return (
    <Card>
      <CardHeader
        title={t('Getting set up')}
        description={plural(
          remaining,
          '{n} step left before everything this can do is switched on.',
          '{n} steps left before everything this can do is switched on.',
        )}
        actions={
          <Button variant="ghost" size="icon" aria-label={t(
            'Dismiss the checklist',
          )} onClick={dismiss}>
            <X className="size-4" />
          </Button>
        }
      />
      <ul className="space-y-1 px-4 pb-4">
        {steps.map((step) => (
          <li key={step.key}>
            <Link
              to={step.href}
              className="flex items-start gap-2.5 rounded-lg px-2 py-1.5 hover:bg-sunken"
            >
              {step.done ? (
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
              ) : (
                <Circle className="mt-0.5 size-4 shrink-0 text-subtle" aria-hidden />
              )}
              <span className="min-w-0">
                <span
                  className={
                    step.done ? 'text-[13px] text-muted line-through' : 'text-[13px] font-medium text-ink'
                  }
                >
                  {t(step.label)}
                </span>
                {!step.done ? (
                  <span className="block text-[12px] leading-relaxed text-muted">{t(
                    step.detail,
                  )}</span>
                ) : null}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}
