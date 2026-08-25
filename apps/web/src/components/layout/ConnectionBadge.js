import { jsx as _jsx } from "react/jsx-runtime";
/**
 * Live-connection indicator.
 *
 * Small but load-bearing: when the socket drops, streaming silently stops, and
 * without a visible signal the app just looks broken. Green is deliberately
 * quiet — only the degraded states draw the eye.
 */
import { Wifi, WifiOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { socket } from '@/lib/socket';
import { Tooltip } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';
const COPY = {
    open: { label: 'Live', detail: 'Connected. Streaming updates in real time.' },
    connecting: { label: 'Connecting', detail: 'Reconnecting to the server…' },
    closed: { label: 'Offline', detail: 'Disconnected. Retrying automatically.' },
    unauthorised: { label: 'Signed out', detail: 'Your session expired. Sign in again.' },
};
export function ConnectionBadge() {
    const [state, setState] = useState(socket.connectionState);
    useEffect(() => socket.onState(setState), []);
    const copy = COPY[state];
    return (_jsx(Tooltip, { content: copy.detail, side: "right", children: _jsx("span", { className: cn('flex size-8 items-center justify-center rounded-lg', state === 'open' && 'text-success', state === 'connecting' && 'animate-pulse text-warning', (state === 'closed' || state === 'unauthorised') && 'text-danger'), role: "status", "aria-label": copy.label, children: state === 'open' || state === 'connecting' ? (_jsx(Wifi, { className: "size-4", "aria-hidden": true })) : (_jsx(WifiOff, { className: "size-4", "aria-hidden": true })) }) }));
}
//# sourceMappingURL=ConnectionBadge.js.map