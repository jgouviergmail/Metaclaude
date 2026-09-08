/**
 * The worker's own contract, driven as a worker.
 *
 * `worker.ts` is an entry point: it reads `workerData`, does one extraction
 * and posts one message. What can be tested about it is exactly that
 * exchange, so this spawns the *built* file the way the product does and
 * checks both shapes of answer.
 *
 * `worker-extractor.test.ts` covers the class that spawns it; this covers the
 * protocol between them, which is where a change on one side silently stops
 * matching the other.
 */

import { existsSync, readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';

import type { WorkerResponse } from './worker.js';

const workerUrl = new URL('../../../dist/learning/extract/worker.js', import.meta.url);
const built = existsSync(workerUrl);
const fixture = (name: string): Buffer => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

/** One run of the worker, resolving with whatever it posts. */
function run(input: { name: string; mime: string; data: Buffer }): Promise<WorkerResponse> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, { workerData: input });
    worker.once('message', (message: WorkerResponse) => {
      resolve(message);
      void worker.terminate();
    });
    worker.once('error', reject);
  });
}

describe.skipIf(!built)('the extraction worker', () => {
  it('answers a success as { ok: true } carrying the whole extraction', async () => {
    const message = await run({ name: 'sample.md', mime: '', data: fixture('sample.md') });
    expect(message.ok).toBe(true);
    if (!message.ok) return;
    expect(message.out.text).toContain('# Conventions');
    expect(message.out).toMatchObject({
      pageBreaks: expect.any(Array),
      pageUnit: null,
      extractor: expect.stringMatching(/^text@/),
    });
  });

  it('answers a refusal as { ok: false } with a code and a sentence', async () => {
    const message = await run({ name: 'a.zip', mime: 'application/zip', data: Buffer.from('x') });
    expect(message.ok).toBe(false);
    if (message.ok) return;
    expect(message.code).toBe('unsupported');
    expect(message.message).toContain('.pdf');
  });

  it('carries a page map across the boundary intact', async () => {
    // The offsets are the whole point of the trip: a clone that dropped or
    // reordered them would mislocate every citation of every uploaded PDF.
    const message = await run({ name: 'assurance.pdf', mime: '', data: fixture('assurance.pdf') });
    expect(message.ok).toBe(true);
    if (!message.ok) return;
    expect(message.out.pageBreaks).toHaveLength(2);
    expect(message.out.pageUnit).toBe('page');
    for (const at of message.out.pageBreaks) {
      expect(message.out.text.slice(at, at + 7)).toBe('Article');
    }
  });

  it('never answers with an Error object, which would not survive the clone', async () => {
    const message = await run({ name: 'a.txt', mime: 'text/plain', data: Buffer.alloc(0) });
    expect(message).toEqual({ ok: false, code: 'empty', message: 'The file is empty.' });
  });
});

if (!built) {
  it('says why the worker protocol cases did not run', () => {
    console.warn(
      'extraction worker cases skipped: apps/api/dist is not built. Run `pnpm --filter @metaclaude/api build`; CI builds before it tests.',
    );
    expect(built).toBe(false);
  });
}
