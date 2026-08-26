import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Toaster } from 'sonner';
import { App } from './App';
import { ApiError } from './lib/api';
import { TooltipProvider } from './components/ui/primitives';
import './styles/index.css';

/**
 * Query keys that must never refetch on a timer.
 *
 * Everything else on this screen is a view of server state, and a view should
 * catch up on its own. Three kinds of query are not.
 *
 * A file's query result seeds an editor the operator may be typing into, and a
 * background refetch that replaced the buffer would delete their work with no
 * undo and no warning. The search queries are keyed by what is being typed, so
 * polling them re-runs a query the user has already moved past.
 *
 * The Claude catalogue is different again: reading it spawns a CLI subprocess.
 * On the default interval every open tab would start one twice a minute, for an
 * answer that changes when the operator changes it — which is what the explicit
 * Refresh button is for.
 */
const NEVER_POLL = new Set(['file', 'file-search', 'memory-search', 'claude-catalogue']);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Session transcripts and run state arrive on the WebSocket, and that
      // remains the fast path. But most screens — analytics, memory, insights,
      // automations, the audit log — are fed by no frame at all, so until now
      // they only caught up when the window regained focus. On a tablet left
      // open on the dashboard that is never, and the OS looked frozen.
      //
      // Polling is paused automatically while the tab is hidden, so this costs
      // nothing when nobody is looking. Pages gate their skeletons on
      // `isLoading`, which is true only for the first fetch, so a refresh
      // arriving this way replaces the numbers without the screen flinching.
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      refetchInterval: (query) => (NEVER_POLL.has(String(query.queryKey?.[0] ?? '')) ? false : 30_000),
      retry: (failureCount, error) => {
        // Retrying an auth or permission failure never helps.
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
        return failureCount < 2;
      },
    },
    mutations: { retry: false },
  },
});

const container = document.getElementById('root');
if (!container) throw new Error('Root element missing from index.html');

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <TooltipProvider>
          <App />
          <Toaster
            position="bottom-right"
            closeButton
            richColors
            // Inherit the app's own surfaces so toasts do not look bolted on.
            toastOptions={{
              style: {
                background: 'var(--mc-surface-raised)',
                border: '1px solid var(--mc-border)',
                color: 'var(--mc-text)',
              },
            }}
          />
        </TooltipProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);

// Register the service worker for offline shell + installability. Failure is
// non-fatal: the app works fine without it.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* Offline support unavailable; the app still runs online. */
    });
  });
}
