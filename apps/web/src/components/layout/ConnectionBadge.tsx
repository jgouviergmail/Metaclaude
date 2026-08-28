/**
 * Live-connection indicator.
 *
 * Small but load-bearing: when the socket drops, streaming silently stops, and
 * without a visible signal the app just looks broken. Green is deliberately
 * quiet — only the degraded states draw the eye.
 */

import { Wifi, WifiOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useT } from '@/lib/i18n';
import { socket, type ConnectionState } from '@/lib/socket';
import { Tooltip } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';

const COPY: Record<ConnectionState, { label: string; detail: string }> = {
  open: { label: 'Live', detail: 'Connected. Streaming updates in real time.' },
  connecting: { label: 'Connecting', detail: 'Reconnecting to the server…' },
  closed: { label: 'Offline', detail: 'Disconnected. Retrying automatically.' },
  unauthorised: { label: 'Signed out', detail: 'Your session expired. Sign in again.' },
};

export function ConnectionBadge() {
  const t = useT();
  const [state, setState] = useState<ConnectionState>(socket.connectionState);

  useEffect(() => socket.onState(setState), []);

  const copy = COPY[state];

  return (
    // Both strings go through `t`: the badge imported `useT` and never called
    // it, so the French catalogue carried translations for all four states
    // that nothing ever reached.
    <Tooltip content={t(copy.detail)} side="right">
      <span
        className={cn(
          'flex size-8 items-center justify-center rounded-lg',
          state === 'open' && 'text-success',
          state === 'connecting' && 'animate-pulse text-warning',
          (state === 'closed' || state === 'unauthorised') && 'text-danger',
        )}
        role="status"
        aria-label={t(copy.label)}
      >
        {state === 'open' || state === 'connecting' ? (
          <Wifi className="size-4" aria-hidden />
        ) : (
          <WifiOff className="size-4" aria-hidden />
        )}
      </span>
    </Tooltip>
  );
}
