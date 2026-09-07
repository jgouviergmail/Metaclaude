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
    const copy = boundaryCopy();

    return (
      <div className="flex min-h-dvh items-center justify-center bg-surface p-6">
        <div className="w-full max-w-md space-y-4 rounded-xl border border-line bg-raised p-6 text-center shadow-[var(--mc-shadow)]">
          <h1 className="text-title font-semibold text-ink">{copy.title}</h1>
          <p className="text-body leading-relaxed text-muted">{copy.body}</p>
          <p className="rounded-md bg-sunken px-3 py-2 text-left font-mono text-caption text-subtle">
            {this.state.error.message || String(this.state.error)}
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="w-full rounded-lg bg-accent px-4 py-2 text-body font-medium text-accent-ink transition-opacity hover:opacity-90"
          >
            {copy.reload}
          </button>
        </div>
      </div>
    );
  }
}

/**
 * This screen's words, without the translator.
 *
 * Every other component reads the catalogue through `useT`, and this one
 * deliberately cannot: an error boundary has to be a class, so no hook runs
 * here — and more to the point, the provider is one of the things it might be
 * catching. A boundary that needs the context to render its own apology is a
 * boundary that renders nothing on the day it matters.
 *
 * So the language comes straight from where the provider stored it, and the
 * three strings live here. Three strings duplicated is the right price for a
 * screen with no dependencies at all.
 */
function boundaryCopy(): { title: string; body: string; reload: string } {
  let french = false;
  try {
    const stored = window.localStorage.getItem('mc-lang');
    french = stored === 'fr' || (stored === null && navigator.language?.toLowerCase().startsWith('fr'));
  } catch {
    // Blocked storage costs the preference, never the screen.
  }

  return french
    ? {
        title: 'Une erreur est survenue',
        body: "L'interface a rencontré une erreur dont elle n'a pas pu se remettre seule. Recharger suffit presque toujours — le plus souvent, l'application a été mise à jour pendant que cet onglet était ouvert.",
        reload: 'Recharger',
      }
    : {
        title: 'Something went wrong',
        body: 'The interface hit an error it could not recover from on its own. Reloading usually fixes it — most often this means the app was updated while this tab was open.',
        reload: 'Reload',
      };
}
