/**
 * The hot half of the embeddings setting.
 *
 * Switching to `hash` is immediate; switching to `local` hands the stores the
 * model's id at once — they answer lexically until it is ready — and the
 * rebuild follows the model's readiness. What this module exists to get right
 * is the *second* switch: an owner who toggles local → hash → local within a
 * minute must not load a second copy of a 570 MB model beside the first, and
 * one whose model failed to load must be able to try again once the files
 * are in place. So the local provider is kept and reused while it is loading
 * or ready, and rebuilt only after it has given up.
 */

import {
  createEmbeddingProvider,
  HashingEmbedder,
  type EmbeddingConfig,
  type EmbeddingProvider,
  type ManagedEmbedder,
  type SwitchableEmbedder,
} from './embeddings.js';

export interface EmbedderSwitchDeps {
  embedder: SwitchableEmbedder;
  model: string;
  cacheDir: string;
  /** Asked for after a switch to hashing, and by the model when it becomes ready. */
  rebuild: () => void;
  onFallback: (id: string, reason: string) => void;
  log: (level: 'info' | 'warn', message: string) => void;
  /** The factory, injectable so the reuse rule can be tested without a model. */
  create?: (config: EmbeddingConfig) => Promise<ManagedEmbedder>;
  /** The provider the process booted with, if it is the local one — reused rather than reloaded. */
  initial?: EmbeddingProvider;
}

export interface EmbedderSwitch {
  apply(provider: string): void;
  /** The local provider currently held, if any — for tests and the doctor. */
  local(): ManagedEmbedder | null;
}

const isLocal = (provider: EmbeddingProvider | undefined): provider is ManagedEmbedder =>
  provider !== undefined && provider.family === 'st';

export function createEmbedderSwitch(deps: EmbedderSwitchDeps): EmbedderSwitch {
  const create = deps.create ?? createEmbeddingProvider;
  let local: ManagedEmbedder | null = isLocal(deps.initial) ? deps.initial : null;

  const loadLocal = (): void => {
    void create({
      provider: 'local',
      model: deps.model,
      cacheDir: deps.cacheDir,
      log: deps.log,
      onReady: () => deps.rebuild(),
      onFallback: deps.onFallback,
    }).then((provider) => {
      local = provider;
      deps.embedder.use(provider);
      deps.log('info', `embeddings: switching to ${provider.id}; lexical-only until it is ready`);
    });
  };

  return {
    apply(provider) {
      if (provider === 'hash') {
        if (deps.embedder.family === 'hash') return;
        deps.embedder.use(new HashingEmbedder());
        deps.log('info', 'embeddings: switched to the hashing embedder; rebuilding vectors');
        deps.rebuild();
        return;
      }
      if (deps.embedder.family === 'st') return;
      // A model still loading, or loaded, is reused: its readiness callback
      // will (or did) ask for the rebuild, and the stores only need its id.
      // One that gave up is dropped and loaded afresh — the retry.
      if (local && local.id === `st:${deps.model}` && isStillUsable(local)) {
        deps.embedder.use(local);
        deps.log('info', `embeddings: back to ${local.id}${local.ready ? '' : ' (still loading)'}`);
        if (local.ready) deps.rebuild();
        return;
      }
      loadLocal();
    },
    local: () => local,
  };
}

/** Loading or ready — anything but a provider that has given up. */
function isStillUsable(provider: ManagedEmbedder): boolean {
  const state = (provider as { state?: string }).state;
  return provider.ready || state === 'loading' || state === undefined;
}
