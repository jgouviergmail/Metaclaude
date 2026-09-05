/**
 * The switch keeps one model in memory, and retries only a failed one.
 */

import { describe, expect, it } from 'vitest';
import { ConceptEmbedder } from '../test/embedders.js';
import { createEmbedderSwitch } from './embedder-switch.js';
import {
  HashingEmbedder,
  LocalTransformerEmbedder,
  SwitchableEmbedder,
  type EmbeddingConfig,
  type FeatureExtractionPipeline,
  type ManagedEmbedder,
} from './embeddings.js';

const okPipeline: FeatureExtractionPipeline = async (texts) => ({
  tolist: () => texts.map(() => [1, 0, 0, 0]),
});

/** A factory that builds real local providers around an injected loader, and counts. */
function factory(load: () => Promise<FeatureExtractionPipeline>) {
  const created: Array<LocalTransformerEmbedder & ManagedEmbedder> = [];
  const create = async (config: EmbeddingConfig): Promise<ManagedEmbedder> => {
    const local = new LocalTransformerEmbedder(config.model, { load });
    const settled = local
      .warmup()
      .then(() => config.onReady?.(local.id))
      .catch((error: unknown) => config.onFallback?.(local.id, error instanceof Error ? error.message : String(error)));
    const managed = Object.assign(local, { whenSettled: () => settled });
    created.push(managed);
    return managed;
  };
  return { create, created };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function harness(load: () => Promise<FeatureExtractionPipeline>) {
  const embedder = new SwitchableEmbedder(new HashingEmbedder());
  const { create, created } = factory(load);
  const events: string[] = [];
  const toggle = createEmbedderSwitch({
    embedder,
    model: 'Xenova/bge-m3',
    cacheDir: '/nowhere',
    rebuild: () => events.push('rebuild'),
    onFallback: (id, reason) => events.push(`fallback ${id}: ${reason}`),
    log: () => {},
    create,
  });
  return { embedder, toggle, created, events };
}

describe('createEmbedderSwitch', () => {
  it('switches to the model at once and rebuilds when it is ready; switches back to hashing immediately', async () => {
    const { embedder, toggle, created, events } = harness(async () => okPipeline);

    toggle.apply('local');
    await tick();
    expect(embedder.id).toBe('st:Xenova/bge-m3');
    await created[0]!.warmup();
    await tick();
    expect(embedder.ready).toBe(true);
    expect(events).toEqual(['rebuild']);

    toggle.apply('hash');
    expect(embedder.family).toBe('hash');
    expect(events).toEqual(['rebuild', 'rebuild']);
  });

  /**
   * The case that costs a gigabyte: local → hash → local inside a minute.
   * The first model is still there, loading or loaded; it is handed back to
   * the stores rather than loaded a second time beside the first.
   */
  it('reuses the model already loaded — or still loading — rather than loading another', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { embedder, toggle, created, events } = harness(async () => {
      await gate;
      return okPipeline;
    });

    toggle.apply('local');
    await tick();
    toggle.apply('hash');
    toggle.apply('local');
    await tick();

    expect(created).toHaveLength(1);
    expect(embedder.id).toBe('st:Xenova/bge-m3');
    expect(embedder.ready).toBe(false);

    release();
    await created[0]!.warmup();
    await tick();
    expect(embedder.ready).toBe(true);
    // One rebuild for the readiness — the interim switch to hashing rebuilt too.
    expect(events.filter((event) => event === 'rebuild')).toHaveLength(2);

    // Loaded and switched away again: coming back costs no load and rebuilds at once.
    toggle.apply('hash');
    toggle.apply('local');
    expect(created).toHaveLength(1);
    expect(embedder.ready).toBe(true);
    expect(events.filter((event) => event === 'rebuild')).toHaveLength(4);
  });

  it('retries a model that gave up, so fixing the files needs no restart', async () => {
    let attempts = 0;
    const { embedder, toggle, created, events } = harness(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('files missing');
      return okPipeline;
    });

    toggle.apply('local');
    await tick();
    await created[0]!.whenSettled();
    expect(embedder.ready).toBe(false);
    expect(events[0]).toMatch(/fallback st:Xenova\/bge-m3: files missing/);

    toggle.apply('hash');
    toggle.apply('local');
    await tick();
    await created[1]!.whenSettled();

    expect(created).toHaveLength(2);
    expect(embedder.ready).toBe(true);
  });

  it('ignores a request for the provider already in force', () => {
    const { embedder, toggle, created, events } = harness(async () => okPipeline);

    toggle.apply('hash');
    expect(created).toHaveLength(0);
    expect(events).toEqual([]);
    expect(embedder.family).toBe('hash');
  });

  it('adopts the local provider the process booted with instead of loading it again', async () => {
    const booted = Object.assign(new ConceptEmbedder({ id: 'st:Xenova/bge-m3' }), { whenSettled: async () => undefined });
    const embedder = new SwitchableEmbedder(booted);
    const { create, created } = factory(async () => okPipeline);
    const events: string[] = [];
    const toggle = createEmbedderSwitch({
      embedder, model: 'Xenova/bge-m3', cacheDir: '/nowhere', rebuild: () => events.push('rebuild'),
      onFallback: () => {}, log: () => {}, create, initial: booted,
    });

    toggle.apply('hash');
    toggle.apply('local');

    expect(created).toHaveLength(0);
    expect(embedder.id).toBe('st:Xenova/bge-m3');
    expect(events).toEqual(['rebuild', 'rebuild']);
  });
});
