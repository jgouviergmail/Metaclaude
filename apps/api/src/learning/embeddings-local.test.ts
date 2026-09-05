/**
 * The local sentence-transformer, without a model.
 *
 * The pipeline is injected, so what is under test is everything around it:
 * that nothing is written or compared before the model is ready, that a
 * failed load leaves the deployment *explicitly* lexical rather than silently
 * hashing, that the pooling and the dimension come from the model rather than
 * from a constant, and that two callers never run the model at once. Every one
 * of those was either a defect found in review or a measurement: a 384 hard
 * wired into a 1024-dimensional model, a `mean` pooling on a CLS model, a
 * fallback that re-embedded the whole corpus in hashing on every failed boot.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createEmbeddingProvider,
  EmbedderNotReadyError,
  HashingEmbedder,
  LocalTransformerEmbedder,
  MODEL_PROFILES,
  SwitchableEmbedder,
  type FeatureExtractionPipeline,
} from './embeddings.js';

/** A pipeline that answers a fixed dimension and records how it was called. */
function fakePipeline(dimension: number) {
  const calls: Array<{ texts: string[]; options: { pooling: string; normalize: boolean } }> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const pipeline: FeatureExtractionPipeline = async (texts, options) => {
    calls.push({ texts, options });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return {
      tolist: () =>
        texts.map((text) => {
          const vector = new Array<number>(dimension).fill(0);
          vector[text.length % dimension] = 1;
          return vector;
        }),
    };
  };
  return { pipeline, calls, maxInFlight: () => maxInFlight };
}

describe('LocalTransformerEmbedder', () => {
  it('is not ready until the model has loaded, and refuses to embed before that', async () => {
    const { pipeline } = fakePipeline(1024);
    const embedder = new LocalTransformerEmbedder('Xenova/bge-m3', { load: async () => pipeline });

    expect(embedder.ready).toBe(false);
    expect(embedder.state).toBe('loading');
    expect(embedder.family).toBe('st');
    expect(embedder.id).toBe('st:Xenova/bge-m3');
    await expect(embedder.embed('x')).rejects.toThrow(EmbedderNotReadyError);

    await embedder.warmup();

    expect(embedder.ready).toBe(true);
    expect(embedder.state).toBe('ready');
    // Discovered from the model, not declared: bge-m3 is 1024-dimensional.
    expect(embedder.dimension).toBe(1024);
    expect((await embedder.embed('x')).length).toBe(1024);
  });

  it('uses the pooling the model was trained with', async () => {
    const cls = fakePipeline(1024);
    await new LocalTransformerEmbedder('Xenova/bge-m3', { load: async () => cls.pipeline }).warmup();
    expect(cls.calls[0]?.options).toEqual({ pooling: 'cls', normalize: true });

    const mean = fakePipeline(384);
    await new LocalTransformerEmbedder('Xenova/paraphrase-multilingual-MiniLM-L12-v2', { load: async () => mean.pipeline }).warmup();
    expect(mean.calls[0]?.options).toEqual({ pooling: 'mean', normalize: true });

    expect(MODEL_PROFILES['Xenova/bge-m3']?.pooling).toBe('cls');
  });

  /**
   * The old behaviour: a failed load quietly became the hashing embedder, and
   * the boot then re-embedded every vector in hashing — to do it all again the
   * other way at the next boot that loaded. A deployment that asked for a
   * model and has none is lexical-only, says so, and writes no vectors.
   */
  it('stays explicitly lexical-only when the model cannot load, keeping its own id', async () => {
    const embedder = new LocalTransformerEmbedder('Xenova/bge-m3', {
      load: async () => {
        throw new Error("Cannot find package '@huggingface/transformers'");
      },
    });

    await expect(embedder.warmup()).rejects.toThrow(/Cannot find package/);

    expect(embedder.ready).toBe(false);
    expect(embedder.state).toBe('lexical-only');
    expect(embedder.lastError).toMatch(/Cannot find package/);
    expect(embedder.id).toBe('st:Xenova/bge-m3');
    expect(embedder.family).toBe('st');
  });

  it('loads once however many callers warm it up', async () => {
    const load = vi.fn(async () => fakePipeline(1024).pipeline);
    const embedder = new LocalTransformerEmbedder('Xenova/bge-m3', { load });

    await Promise.all([embedder.warmup(), embedder.warmup(), embedder.warmup()]);
    await embedder.warmup();

    expect(load).toHaveBeenCalledTimes(1);
  });

  /**
   * Measured: a batch of sixteen 1200-character chunks pushed the process to
   * 1.27 GB where a query sits at 1.0 GB. Two concurrent batches would add,
   * and the container shares its ceiling with the CLI. So: one model call at a
   * time, and no call over the batch ceiling.
   */
  it('runs the model one call at a time and never over the batch ceiling', async () => {
    const fake = fakePipeline(1024);
    const embedder = new LocalTransformerEmbedder('Xenova/bge-m3', { load: async () => fake.pipeline });
    await embedder.warmup();
    fake.calls.length = 0;

    const texts = Array.from({ length: 20 }, (_, index) => `passage ${index}`);
    const [a, b] = await Promise.all([embedder.embedBatch(texts), embedder.embedBatch(texts.slice(0, 3))]);

    expect(a).toHaveLength(20);
    expect(b).toHaveLength(3);
    expect(fake.maxInFlight()).toBe(1);
    expect(Math.max(...fake.calls.map((call) => call.texts.length))).toBeLessThanOrEqual(LocalTransformerEmbedder.BATCH);
  });

  it('truncates a very long text rather than letting the model cut it somewhere unpredictable', async () => {
    const fake = fakePipeline(1024);
    const embedder = new LocalTransformerEmbedder('Xenova/bge-m3', { load: async () => fake.pipeline });
    await embedder.warmup();

    await embedder.embed('x'.repeat(20_000));

    expect(fake.calls.at(-1)?.texts[0]?.length).toBe(8000);
  });
});

describe('createEmbeddingProvider', () => {
  it('answers at once with a loading local embedder, and reports readiness or the fallback', async () => {
    const fake = fakePipeline(1024);
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const embedder = await createEmbeddingProvider({
      provider: 'local',
      model: 'Xenova/bge-m3',
      cacheDir: '/tmp/none',
      load: async () => {
        await gate;
        return fake.pipeline;
      },
      onReady: (id) => events.push(`ready ${id}`),
      onFallback: (id, reason) => events.push(`fallback ${id}: ${reason}`),
    });

    // The boot is not held: the provider exists, is not ready, and says why.
    expect(embedder.id).toBe('st:Xenova/bge-m3');
    expect(embedder.ready).toBe(false);
    expect(events).toEqual([]);

    release();
    await embedder.whenSettled();

    expect(embedder.ready).toBe(true);
    expect(events).toEqual(['ready st:Xenova/bge-m3']);
  });

  it('reports a fallback once, and the provider stays lexical-only under its own id', async () => {
    const events: string[] = [];
    const embedder = await createEmbeddingProvider({
      provider: 'local',
      model: 'Xenova/bge-m3',
      cacheDir: '/tmp/none',
      load: async () => {
        throw new Error('no such file');
      },
      onReady: (id) => events.push(`ready ${id}`),
      onFallback: (id, reason) => events.push(`fallback ${id}: ${reason}`),
    });
    await embedder.whenSettled();

    expect(embedder.ready).toBe(false);
    expect(embedder.id).toBe('st:Xenova/bge-m3');
    expect(events).toEqual(['fallback st:Xenova/bge-m3: no such file']);
  });

  it('gives the hashing embedder, ready at once, when that is what was asked', async () => {
    const embedder = await createEmbeddingProvider({ provider: 'hash', model: 'ignored', cacheDir: '/tmp/none' });

    expect(embedder.ready).toBe(true);
    expect(embedder.family).toBe('hash');
    expect(embedder.id).toBe(new HashingEmbedder().id);
    await embedder.whenSettled();
  });
});

describe('SwitchableEmbedder', () => {
  it('delegates to whatever it currently holds, and tells listeners when that changes', async () => {
    const hash = new HashingEmbedder();
    const switchable = new SwitchableEmbedder(hash);
    const seen: string[] = [];
    switchable.onChange((provider) => seen.push(provider.id));

    expect(switchable.id).toBe(hash.id);
    expect(switchable.ready).toBe(true);
    expect(switchable.family).toBe('hash');
    expect((await switchable.embed('a')).length).toBe(hash.dimension);

    const local = new LocalTransformerEmbedder('Xenova/bge-m3', { load: async () => fakePipeline(1024).pipeline });
    switchable.use(local);

    expect(switchable.id).toBe('st:Xenova/bge-m3');
    expect(switchable.ready).toBe(false);
    expect(seen).toEqual(['st:Xenova/bge-m3']);

    await local.warmup();
    expect(switchable.ready).toBe(true);
    expect(switchable.dimension).toBe(1024);
  });
});
