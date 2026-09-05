/**
 * Text embeddings.
 *
 * Two providers, chosen by configuration:
 *
 * - `hash`  — a deterministic hashing embedder built on character n-grams and
 *   sub-word tokens, projected into a fixed-dimension space and L2-normalised.
 *   No model download, no native dependency, no network. It is genuinely useful
 *   for the retrieval we need (near-duplicate detection and topical recall over
 *   a personal corpus), and it is the default so the OS works out of the box.
 *
 * - `local` — a sentence-transformer running on-device through
 *   `@huggingface/transformers`. Semantic recall, at the cost of a model on
 *   disk and in memory. Loaded in the background: the provider exists at once,
 *   is not *ready* until the model is, and stays **explicitly lexical-only**
 *   under its own id if the model never loads — never a silent switch to
 *   hashing, which used to re-embed the whole corpus one way at a failed boot
 *   and back the other way at the next. Nothing writes or compares a vector
 *   while `ready` is false; the lexical arm answers alone, and the doctor says
 *   so.
 *
 * Every vector this module returns is L2-normalised, which lets the vector store
 * use a plain dot product as cosine similarity.
 */

import { createHash } from 'node:crypto';
import { HASH_EMBEDDING_DIM } from '@metaclaude/shared';

/**
 * Which kind of vector space this is. The retrieval gates are measurements of
 * a family, not of a model: hashing puts genuine matches at 0.09–0.39, a
 * sentence-transformer puts unrelated text at 0.25–0.45 and paraphrase above
 * 0.5, so every floor in `retrieval.ts` is chosen by family.
 */
export type EmbedderFamily = 'hash' | 'st';

export interface EmbeddingProvider {
  /** Stable identifier stored alongside each vector, e.g. `hash-v1:512`. */
  readonly id: string;
  readonly dimension: number;
  readonly family: EmbedderFamily;
  /**
   * False while a model loads, and for good once it has failed to. No vector
   * is written or compared under a provider that is not ready: a write is
   * stored pending and rebuilt by `reindex`, a search runs its lexical arm.
   */
  readonly ready: boolean;
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
}

/** The value `embedding_model` carries on a row written while no model was ready. */
export const PENDING_EMBEDDING_MODEL = '';

export class EmbedderNotReadyError extends Error {
  constructor(id: string, state: string) {
    super(`The embedder ${id} is ${state}; no vector can be produced yet.`);
    this.name = 'EmbedderNotReadyError';
  }
}

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                              */
/* -------------------------------------------------------------------------- */

/** Scale a vector to unit length in place. A zero vector is left untouched. */
export function l2Normalise(vector: Float32Array): Float32Array {
  let sumSquares = 0;
  for (let i = 0; i < vector.length; i += 1) sumSquares += (vector[i] as number) ** 2;
  if (sumSquares === 0) return vector;
  const inverse = 1 / Math.sqrt(sumSquares);
  for (let i = 0; i < vector.length; i += 1) vector[i] = (vector[i] as number) * inverse;
  return vector;
}

/**
 * Cosine similarity for unit vectors, i.e. a dot product.
 * Returns 0 when the dimensions disagree, which happens when the embedding
 * provider changed and old vectors have not been re-indexed yet.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += (a[i] as number) * (b[i] as number);
  return dot;
}

/**
 * Tokenise into lowercase word tokens.
 * Unicode-aware so accented French text (which this operator writes) tokenises
 * the same way English does.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((token) => token.length > 0 && token.length < 40);
}

/* -------------------------------------------------------------------------- */
/* Hashing embedder                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Feature-hashing embedder ("hashing trick").
 *
 * Features are word unigrams, word bigrams and character 4-grams. Each feature
 * is hashed to a bucket, with a second hash choosing the sign so that collisions
 * cancel out in expectation rather than accumulating. Counts are damped with
 * `1 + log(tf)`, which is the standard sub-linear term-frequency weighting.
 */
export class HashingEmbedder implements EmbeddingProvider {
  readonly id: string;
  readonly dimension: number;
  readonly family = 'hash' as const;
  readonly ready = true;

  constructor(dimension: number = HASH_EMBEDDING_DIM) {
    this.dimension = dimension;
    this.id = `hash-v1:${dimension}`;
  }

  async embed(text: string): Promise<Float32Array> {
    return this.embedSync(text);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => this.embedSync(text));
  }

  /** Synchronous variant — useful in tests and hot paths. */
  embedSync(text: string): Float32Array {
    const vector = new Float32Array(this.dimension);
    const counts = new Map<string, number>();

    const bump = (feature: string): void => {
      counts.set(feature, (counts.get(feature) ?? 0) + 1);
    };

    const tokens = tokenize(text);
    for (let i = 0; i < tokens.length; i += 1) {
      bump(`w:${tokens[i]}`);
      if (i + 1 < tokens.length) bump(`b:${tokens[i]}_${tokens[i + 1]}`);
    }

    // Character n-grams give robustness to typos, inflection and identifiers
    // like `WorkspaceRepo` that word tokenisation splits badly.
    const normalised = text.toLowerCase().normalize('NFKC').replace(/\s+/g, ' ').slice(0, 4000);
    for (let i = 0; i + 4 <= normalised.length; i += 1) {
      bump(`c:${normalised.slice(i, i + 4)}`);
    }

    for (const [feature, count] of counts) {
      const digest = createHash('sha1').update(feature).digest();
      // First 4 bytes select the bucket, the next byte's low bit selects sign.
      const bucket = digest.readUInt32BE(0) % this.dimension;
      const sign = (digest[4] as number) & 1 ? 1 : -1;
      const weight = 1 + Math.log(count);
      vector[bucket] = (vector[bucket] as number) + sign * weight;
    }

    return l2Normalise(vector);
  }
}

/* -------------------------------------------------------------------------- */
/* Local transformer embedder                                                  */
/* -------------------------------------------------------------------------- */

export type FeatureExtractionPipeline = (
  texts: string[],
  options: { pooling: 'mean' | 'cls'; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

/**
 * What a model needs that the pipeline cannot know: bge-m3 is trained with
 * CLS pooling and answers noise under mean pooling; the MiniLM family is
 * mean-pooled. A model absent from this table gets mean pooling, which is the
 * sentence-transformers default and right for most.
 *
 * The e5 family is deliberately *not* here: it embeds queries and passages
 * with different prefixes, which this interface has no seam for, and without
 * them every text scores 0.8 against every other (measured). Naming it would
 * be worse than refusing it.
 */
export const MODEL_PROFILES: Record<string, { pooling: 'mean' | 'cls' }> = {
  'Xenova/bge-m3': { pooling: 'cls' },
  'Xenova/paraphrase-multilingual-MiniLM-L12-v2': { pooling: 'mean' },
  'Xenova/all-MiniLM-L6-v2': { pooling: 'mean' },
};

export type LocalEmbedderState = 'loading' | 'ready' | 'lexical-only';

export interface LocalEmbedderOptions {
  /** Where model files are cached. Ignored when `load` is injected. */
  cacheDir?: string;
  /** The pipeline loader — the real dynamic import, or a fake in tests. */
  load?: () => Promise<FeatureExtractionPipeline>;
}

/**
 * Sentence-transformer embedder backed by `@huggingface/transformers`.
 *
 * The dependency is imported dynamically so a deployment that never enables
 * it does not pay for it. The model loads in the background — `warmup()` is
 * idempotent and is what the factory starts — and until it has, `ready` is
 * false and `embed` refuses: a caller that forgot to look at `ready` gets an
 * error rather than a zero vector stored forever under a real model id.
 *
 * One model call at a time, `BATCH` texts at most. Measured on bge-m3: a
 * query holds the process at ~1.0 GB, a batch of sixteen long chunks at
 * ~1.27 GB, and the container shares its ceiling with the CLI processes the
 * agent spawns. Concurrent batches would add; serialised ones do not.
 */
export class LocalTransformerEmbedder implements EmbeddingProvider {
  static readonly BATCH = 8;

  readonly id: string;
  readonly family = 'st' as const;
  /** Discovered from the first vector the model returns; 0 until then. */
  dimension = 0;
  state: LocalEmbedderState = 'loading';
  lastError: string | null = null;

  private readonly pooling: 'mean' | 'cls';
  private readonly load: () => Promise<FeatureExtractionPipeline>;
  private pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;
  /** The tail of the serialised call chain. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly modelName: string,
    options: LocalEmbedderOptions = {},
  ) {
    this.id = `st:${modelName}`;
    this.pooling = MODEL_PROFILES[modelName]?.pooling ?? 'mean';
    this.load = options.load ?? (() => loadTransformersPipeline(modelName, options.cacheDir ?? ''));
  }

  get ready(): boolean {
    return this.state === 'ready';
  }

  /**
   * Load the model now. Resolves once a first vector has come back, which is
   * what proves the package, the files and the runtime all work; rejects, and
   * leaves the provider lexical-only, when any of them does not.
   */
  async warmup(): Promise<void> {
    this.pipelinePromise ??= (async () => {
      try {
        const pipeline = await this.load();
        const [vector] = await this.run(pipeline, ['warmup']);
        this.dimension = vector?.length ?? 0;
        if (this.dimension === 0) throw new Error('the model returned an empty vector');
        this.state = 'ready';
        return pipeline;
      } catch (error) {
        this.state = 'lexical-only';
        this.lastError = error instanceof Error ? error.message : String(error);
        throw error;
      }
    })();
    await this.pipelinePromise;
  }

  async embed(text: string): Promise<Float32Array> {
    const [vector] = await this.embedBatch([text]);
    return vector as Float32Array;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (!this.ready || !this.pipelinePromise) throw new EmbedderNotReadyError(this.id, this.state);
    const pipeline = await this.pipelinePromise;
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += LocalTransformerEmbedder.BATCH) {
      out.push(...(await this.run(pipeline, texts.slice(i, i + LocalTransformerEmbedder.BATCH))));
    }
    return out;
  }

  /** One call through the model, after every call queued before it. */
  private run(pipeline: FeatureExtractionPipeline, texts: string[]): Promise<Float32Array[]> {
    const call = this.queue.then(async () => {
      // Truncate defensively: the model window is bounded and a very long
      // body would otherwise be cut in a less predictable place.
      const prepared = texts.map((text) => text.slice(0, 8000));
      const output = await pipeline(prepared, { pooling: this.pooling, normalize: true });
      return output.tolist().map((row) => l2Normalise(Float32Array.from(row)));
    });
    // The chain must survive a failed call, or every later call would fail too.
    this.queue = call.catch(() => undefined);
    return call;
  }
}

/** The real loader: the optional package, from the cache directory, offline. */
async function loadTransformersPipeline(
  modelName: string,
  cacheDir: string,
): Promise<FeatureExtractionPipeline> {
  // The specifier is held in a variable so TypeScript does not try to resolve
  // this optional dependency at build time.
  const specifier = '@huggingface/transformers';
  const mod = (await import(specifier)) as unknown as {
    pipeline: (task: string, model: string, options?: unknown) => Promise<unknown>;
    env: { cacheDir?: string; allowRemoteModels?: boolean };
  };
  if (cacheDir) mod.env.cacheDir = cacheDir;
  // The runtime never downloads: the image ships the model, and a boot on a
  // host without it must fail fast and say so — not stall on the network
  // or fetch something nobody reviewed.
  mod.env.allowRemoteModels = false;
  return (await mod.pipeline('feature-extraction', modelName, {
    dtype: 'q8',
  })) as FeatureExtractionPipeline;
}

/** The provider's situation, for the doctor and the settings screen. */
export interface EmbedderStatus {
  id: string;
  family: EmbedderFamily;
  ready: boolean;
  state: LocalEmbedderState;
  lastError: string | null;
  dimension: number;
}

export function describeEmbedder(provider: EmbeddingProvider): EmbedderStatus {
  const inner = provider instanceof SwitchableEmbedder ? provider.provider : provider;
  const local = inner instanceof LocalTransformerEmbedder ? inner : null;
  return {
    id: inner.id,
    family: inner.family,
    ready: inner.ready,
    state: local ? local.state : 'ready',
    lastError: local?.lastError ?? null,
    dimension: inner.dimension,
  };
}

/* -------------------------------------------------------------------------- */
/* Switchable                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The provider every store holds: a handle whose contents can change.
 *
 * The stores keep one reference for the life of the process, and the
 * embedder is an operational setting an owner may change without a restart.
 * Delegating through this object is what makes the switch a single `use()`:
 * `id` changes, so every row written under the old one reads as stale and
 * `reindex` rebuilds it — the machinery that already existed for a restart.
 */
export class SwitchableEmbedder implements EmbeddingProvider {
  private readonly listeners = new Set<(provider: EmbeddingProvider) => void>();

  constructor(private current: EmbeddingProvider) {}

  get id(): string {
    return this.current.id;
  }

  get dimension(): number {
    return this.current.dimension;
  }

  get family(): EmbedderFamily {
    return this.current.family;
  }

  get ready(): boolean {
    return this.current.ready;
  }

  /** The provider underneath, for the doctor and the settings screen. */
  get provider(): EmbeddingProvider {
    return this.current;
  }

  embed(text: string): Promise<Float32Array> {
    return this.current.embed(text);
  }

  embedBatch(texts: string[]): Promise<Float32Array[]> {
    return this.current.embedBatch(texts);
  }

  use(provider: EmbeddingProvider): void {
    if (provider === this.current) return;
    this.current = provider;
    for (const listener of this.listeners) listener(provider);
  }

  onChange(listener: (provider: EmbeddingProvider) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                     */
/* -------------------------------------------------------------------------- */

export interface EmbeddingConfig {
  provider: 'hash' | 'local';
  model: string;
  cacheDir: string;
  log?: (level: 'info' | 'warn', message: string) => void;
  /** Injected loader, for tests and benches. */
  load?: () => Promise<FeatureExtractionPipeline>;
  /** The model came up: the moment to rebuild stale vectors. */
  onReady?: (id: string) => void;
  /** The model will not come up this boot: the moment to warn and notify. */
  onFallback?: (id: string, reason: string) => void;
}

/** What the factory returns: a provider, and a way to wait for its verdict. */
export interface ManagedEmbedder extends EmbeddingProvider {
  /** Resolves once the model is ready or has given up — never rejects. */
  whenSettled(): Promise<void>;
}

/**
 * Build the configured provider without waiting for it.
 *
 * `local` returns at once in the `loading` state and warms up in the
 * background: the model takes tens of seconds on a small server and the
 * health endpoint the deploy gate waits on must not sit behind it. The verdict
 * arrives through the callbacks — and through `whenSettled()`, for a bench or
 * a test that wants to wait. A failure leaves the provider lexical-only under
 * its own id; there is no fallback to hashing, by decision (see the module
 * comment).
 */
export async function createEmbeddingProvider(config: EmbeddingConfig): Promise<ManagedEmbedder> {
  if (config.provider === 'hash') {
    return Object.assign(new HashingEmbedder(), { whenSettled: async () => undefined });
  }

  const local = new LocalTransformerEmbedder(config.model, {
    cacheDir: config.cacheDir,
    ...(config.load ? { load: config.load } : {}),
  });
  const settled = local
    .warmup()
    .then(() => {
      config.log?.('info', `embeddings: local model ${config.model} ready (${local.dimension}d)`);
      config.onReady?.(local.id);
    })
    .catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      config.log?.(
        'warn',
        `embeddings: local model "${config.model}" unavailable (${reason}); retrieval is lexical-only until it loads`,
      );
      config.onFallback?.(local.id, reason);
    });
  return Object.assign(local, { whenSettled: () => settled });
}
