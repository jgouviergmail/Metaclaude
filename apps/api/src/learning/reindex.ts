/**
 * Rebuilding vectors after the embedder changes underneath the corpus.
 *
 * An embedding is only comparable to another produced by the same provider, so
 * every stored vector carries the id that made it. `search` skips a row whose
 * id does not match the live embedder, and `findNearDuplicate` skips it too —
 * which means switching `METACLAUDE_EMBEDDINGS`, or having `local` fall back to
 * `hash` because the optional package is missing, silently turns off *both*
 * dense retrieval and deduplication. Nothing fails, nothing is logged past one
 * line at boot, and the only cure was an operator happening to press Re-index.
 *
 * So the boot does it. The count is one cheap query, the work is skipped
 * entirely when there is nothing stale, and it runs in the background: a corpus
 * that needs rebuilding must not hold up the health endpoint the deploy gate
 * waits on.
 */

import type { Db } from '../db/index.js';
import type { EmbeddingProvider } from './embeddings.js';

/** What this needs from a store — both of the real ones satisfy it. */
export interface Reindexable {
  reindex(): Promise<number>;
}

export interface ReindexDeps {
  db: Db;
  memory: Reindexable;
  knowledge: Reindexable;
  /** The live embedder's id, as written into `embedding_model`. */
  classifier: Reindexable;
  /** The live provider: its id says what is stale, its readiness whether anything can be rebuilt yet. */
  embedder: Pick<EmbeddingProvider, 'id' | 'ready'>;
  log: (level: 'info' | 'warn', message: string, data?: Record<string, unknown>) => void;
}

/** Rows whose vectors were made by a different provider than the live one. */
export interface StaleCounts {
  memories: number;
  documents: number;
  exemplars: number;
}

export function countStale(db: Db, embedderId: string): StaleCounts {
  const memories =
    db
      .prepare<[string], { n: number }>(
        // `IS NOT` rather than `!=`: a null model — a row written before the
        // column existed, or an embedding that failed — is stale too, and
        // `NULL != 'x'` is null, which SQLite counts as false.
        'SELECT COUNT(*) AS n FROM memories WHERE embedding_model IS NOT ?',
      )
      .get(embedderId)?.n ?? 0;
  const documents =
    db
      .prepare<[string], { n: number }>(
        'SELECT COUNT(*) AS n FROM documents WHERE embedding_model IS NOT ?',
      )
      .get(embedderId)?.n ?? 0;
  const exemplars =
    db
      .prepare<[string], { n: number }>(
        'SELECT COUNT(*) AS n FROM task_exemplars WHERE embedding_model IS NOT ?',
      )
      .get(embedderId)?.n ?? 0;
  return { memories, documents, exemplars };
}

/**
 * Rebuild what the current embedder cannot read, and report what was done.
 *
 * Never throws: a failure here degrades retrieval, exactly as it is degraded
 * already, and must not take the boot down with it.
 */
export async function reindexStale(deps: ReindexDeps): Promise<StaleCounts> {
  const none: StaleCounts = { memories: 0, documents: 0, exemplars: 0 };
  const stale = countStale(deps.db, deps.embedder.id);
  if (stale.memories === 0 && stale.documents === 0 && stale.exemplars === 0) return none;
  // Nothing can be rebuilt without a model. The rows stay pending, the lexical
  // arm keeps answering, and the provider's `onReady` calls this again.
  if (!deps.embedder.ready) {
    deps.log('info', 'vectors are waiting for the embedding model', { embedder: deps.embedder.id, ...stale });
    return none;
  }

  deps.log(
    'info',
    'the embedding provider changed since these were written — rebuilding their vectors',
    { embedder: deps.embedder.id, ...stale },
  );

  const done: StaleCounts = { memories: 0, documents: 0, exemplars: 0 };
  try {
    done.memories = await deps.memory.reindex();
  } catch (error) {
    deps.log('warn', 'could not rebuild memory vectors', { message: (error as Error).message });
  }
  try {
    done.documents = await deps.knowledge.reindex();
  } catch (error) {
    deps.log('warn', 'could not rebuild knowledge vectors', { message: (error as Error).message });
  }
  try {
    done.exemplars = await deps.classifier.reindex();
  } catch (error) {
    deps.log('warn', 'could not rebuild classifier vectors', { message: (error as Error).message });
  }

  deps.log('info', 'vectors rebuilt', { ...done });
  return done;
}

/**
 * A rebuild that can be asked for from anywhere, any number of times.
 *
 * Boot, a model becoming ready, a setting change and every large document
 * saved all ask for the same pass. Two passes at once would walk the same
 * stale rows and embed them twice — the model serialises calls, so nothing
 * breaks, but the work doubles. One pass runs at a time; asks that arrive
 * while it runs collapse into exactly one more, which sees whatever they
 * added.
 */
export function createRebuildTrigger(run: () => Promise<unknown>): {
  trigger: () => void;
  inFlight: () => boolean;
} {
  let running = false;
  let again = false;
  const go = (): void => {
    running = true;
    void run()
      .catch(() => undefined)
      .finally(() => {
        running = false;
        if (again) {
          again = false;
          go();
        }
      });
  };
  return {
    trigger: () => {
      if (running) again = true;
      else go();
    },
    inFlight: () => running,
  };
}
