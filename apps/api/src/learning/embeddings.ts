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
 *   `@huggingface/transformers`. Better semantic recall, at the cost of a
 *   ~90 MB model download on first use. Loaded lazily and falls back to `hash`
 *   if the package or the model is unavailable, so enabling it can never break
 *   a running deployment.
 *
 * Every vector this module returns is L2-normalised, which lets the vector store
 * use a plain dot product as cosine similarity.
 */

import { createHash } from 'node:crypto';
import { HASH_EMBEDDING_DIM } from '@metaclaude/shared';

export interface EmbeddingProvider {
  /** Stable identifier stored alongside each vector, e.g. `hash-v1:512`. */
  readonly id: string;
  readonly dimension: number;
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
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

type FeatureExtractionPipeline = (
  texts: string[],
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

/**
 * Sentence-transformer embedder backed by `@huggingface/transformers`.
 *
 * The dependency is optional and imported dynamically: a deployment that never
 * enables it does not pay for it, and a broken install degrades to the hashing
 * embedder instead of failing the boot.
 */
export class LocalTransformerEmbedder implements EmbeddingProvider {
  readonly id: string;
  /** all-MiniLM-L6-v2 and its common substitutes are all 384-dimensional. */
  readonly dimension = 384;

  private pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

  constructor(
    private readonly modelName: string,
    private readonly cacheDir: string,
  ) {
    this.id = `st:${modelName}`;
  }

  private async getPipeline(): Promise<FeatureExtractionPipeline> {
    this.pipelinePromise ??= (async () => {
      // The specifier is held in a variable so TypeScript does not try to
      // resolve this optional peer dependency at build time. It is only
      // installed when the operator opts into local embeddings.
      const specifier = '@huggingface/transformers';
      const mod = (await import(specifier)) as unknown as {
        pipeline: (task: string, model: string, options?: unknown) => Promise<unknown>;
        env: { cacheDir?: string; allowLocalModels?: boolean };
      };
      mod.env.cacheDir = this.cacheDir;
      return (await mod.pipeline('feature-extraction', this.modelName, {
        dtype: 'q8',
      })) as FeatureExtractionPipeline;
    })();
    return this.pipelinePromise;
  }

  async embed(text: string): Promise<Float32Array> {
    const [vector] = await this.embedBatch([text]);
    return vector as Float32Array;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const pipeline = await this.getPipeline();
    // Truncate defensively: the model window is 512 tokens and a very long
    // memory body would otherwise be silently cut in a less predictable place.
    const prepared = texts.map((t) => t.slice(0, 8000));
    const output = await pipeline(prepared, { pooling: 'mean', normalize: true });
    return output.tolist().map((row) => l2Normalise(Float32Array.from(row)));
  }

  /** Force the model to load now, so the first query does not pay for it. */
  async warmup(): Promise<void> {
    await this.embed('warmup');
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
}

/**
 * Build the configured provider.
 *
 * When `local` is requested we verify it actually works before returning it;
 * a missing optional dependency or a failed model download falls back to the
 * hashing embedder with a warning rather than taking the service down.
 */
export async function createEmbeddingProvider(
  config: EmbeddingConfig,
): Promise<EmbeddingProvider> {
  if (config.provider === 'hash') return new HashingEmbedder();

  const local = new LocalTransformerEmbedder(config.model, config.cacheDir);
  try {
    await local.warmup();
    config.log?.('info', `embeddings: using local model ${config.model}`);
    return local;
  } catch (error) {
    config.log?.(
      'warn',
      `embeddings: local model "${config.model}" unavailable (${
        (error as Error).message
      }); falling back to the built-in hashing embedder`,
    );
    return new HashingEmbedder();
  }
}
