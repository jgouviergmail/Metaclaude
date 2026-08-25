import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Toaster } from 'sonner';
import { App } from './App';
import { ApiError } from './lib/api';
import { TooltipProvider } from './components/ui/primitives';
import './styles/index.css';
const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            // Live data arrives over the WebSocket, so polling would only duplicate
            // work. Queries refetch on focus, which covers the case where the socket
            // was down while the tab was in the background.
            staleTime: 15_000,
            refetchOnWindowFocus: true,
            refetchInterval: false,
            retry: (failureCount, error) => {
                // Retrying an auth or permission failure never helps.
                if (error instanceof ApiError && error.status >= 400 && error.status < 500)
                    return false;
                return failureCount < 2;
            },
        },
        mutations: { retry: false },
    },
});
const container = document.getElementById('root');
if (!container)
    throw new Error('Root element missing from index.html');
createRoot(container).render(_jsx(StrictMode, { children: _jsx(QueryClientProvider, { client: queryClient, children: _jsx(BrowserRouter, { children: _jsxs(TooltipProvider, { children: [_jsx(App, {}), _jsx(Toaster, { position: "bottom-right", closeButton: true, richColors: true, 
                        // Inherit the app's own surfaces so toasts do not look bolted on.
                        toastOptions: {
                            style: {
                                background: 'var(--mc-surface-raised)',
                                border: '1px solid var(--mc-border)',
                                color: 'var(--mc-text)',
                            },
                        } })] }) }) }) }));
// Register the service worker for offline shell + installability. Failure is
// non-fatal: the app works fine without it.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(() => {
            /* Offline support unavailable; the app still runs online. */
        });
    });
}
//# sourceMappingURL=main.js.map