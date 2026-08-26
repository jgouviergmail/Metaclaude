/**
 * The last line of defence.
 *
 * React unmounts the whole tree when a render throws and nothing catches it, so
 * without a boundary anywhere the app becomes a blank page with no way back —
 * and this is a `display: standalone` PWA, so on a phone there is no URL bar to
 * reload from.
 *
 * The reachable trigger is not a hypothetical bug. `App.tsx` lazy-loads nine
 * routes inside a `<Suspense>` that has a spinner and no error path, and
 * `public/sw.js` is cache-first for `/assets/`. A tab left open across a deploy
 * therefore asks for a chunk hash that no longer exists: the cache misses, the
 * network answers 404 (or the SPA fallback, with the wrong MIME type), the
 * dynamic import rejects, and the rejection propagates into render.
 *
 * Reload is the right remedy precisely because the shell is network-first —
 * one reload fetches the new index.html and the new chunk names with it.
 * Nothing is lost: the transcript lives on the server, and the composer draft
 * is the only client-side state at risk.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State {
  error: Error | null;
}

export class RootBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The console is the only sink here: shipping errors anywhere else would
    // mean an outbound request from a private tool, which this deployment
    // deliberately does not make.
    console.error('Unhandled error in the React tree', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;

    return (
      <div className="flex min-h-dvh items-center justify-center bg-surface p-6">
        <div className="w-full max-w-md space-y-4 rounded-xl border border-line bg-raised p-6 text-center shadow-[var(--mc-shadow)]">
          <h1 className="text-base font-semibold text-ink">Something went wrong</h1>
          <p className="text-[13px] leading-relaxed text-muted">
            The interface hit an error it could not recover from on its own. Reloading usually
            fixes it — most often this means the app was updated while this tab was open.
          </p>
          <p className="rounded-md bg-sunken px-3 py-2 text-left font-mono text-[11.5px] text-subtle">
            {this.state.error.message || String(this.state.error)}
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="w-full rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-accent-ink transition-opacity hover:opacity-90"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
