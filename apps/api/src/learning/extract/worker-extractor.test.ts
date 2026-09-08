/**
 * The worker, against the built `dist`.
 *
 * A `Worker` loads a *file*, and under vitest the file beside this one is
 * TypeScript that Node will not run — so these cases need `pnpm --filter
 * @metaclaude/api build` to have happened. They skip when it has not, and say
 * so out loud rather than passing quietly: a suite that reports green while
 * the isolation nobody tested is the thing protecting the API from a hostile
 * upload is a suite that lies.
 *
 * CI builds before it tests, so these run there; `check:e2e` drives the same
 * path through a real HTTP request.
 */

import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { ExtractError } from './errors.js';
import { extractInProcess } from './index.js';
import { classifyWorkerError, InProcessExtractor, WorkerExtractor } from './worker-extractor.js';

/**
 * The built worker. This module runs from `src` under vitest, where the
 * neighbour is TypeScript Node will not load, so the tests point the real
 * class at the real built file rather than replace either with a double.
 */
const workerUrl = new URL('../../../dist/learning/extract/worker.js', import.meta.url);
const built = existsSync(workerUrl);
const fixture = (name: string): Buffer => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

describe.skipIf(!built)('WorkerExtractor', () => {
  it('extracts in another thread, and agrees with the same work done here', async () => {
    const input = { name: 'bail.docx', mime: '', data: fixture('bail.docx') };
    const [inWorker, inProcess] = await Promise.all([
      new WorkerExtractor({ workerUrl }).extract(input),
      extractInProcess(input),
    ]);
    expect(inWorker).toEqual(inProcess);
  });

  it('carries a refusal across the thread boundary with its code intact', async () => {
    // The reason the worker answers with a code rather than an Error: a
    // structured clone loses the prototype, so `instanceof` on this side
    // would be false and every refusal would read as an internal failure.
    await expect(
      new WorkerExtractor({ workerUrl }).extract({
        name: 'a.zip',
        mime: 'application/zip',
        data: Buffer.from('x'),
      }),
    ).rejects.toMatchObject({ code: 'unsupported' });

    await expect(
      new WorkerExtractor({ workerUrl }).extract({ name: 'scan.pdf', mime: '', data: fixture('scan.pdf') }),
    ).rejects.toMatchObject({ code: 'no-text' });
  });

  it('gives up on a file that takes too long, and says so', async () => {
    await expect(
      new WorkerExtractor({ workerUrl, timeoutMs: 1 }).extract({
        name: 'deploiement.pptx',
        mime: '',
        data: fixture('deploiement.pptx'),
      }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('settles once, whichever of the timeout and the answer arrives second', async () => {
    // The `settled` guard: a timeout of 1 ms against work that takes about 5
    // means both fire, and a promise that resolved after rejecting — or the
    // reverse — would make the outcome depend on the machine's mood.
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () =>
        new WorkerExtractor({ workerUrl, timeoutMs: 1 })
          .extract({ name: 'deploiement.pptx', mime: '', data: fixture('deploiement.pptx') })
          .then(
            () => 'resolved',
            (error: { code?: string }) => error.code,
          ),
      ),
    );
    // Every one settled, and each settled as exactly one thing.
    for (const outcome of outcomes) expect(['timeout', 'resolved']).toContain(outcome);
  });

});

describe('classifyWorkerError', () => {
  // Asserted here rather than by exhausting a real worker's heap: doing that
  // inside a test takes the runner's own pool down with it. The branch that
  // matters is the translation, and the message it keys on was measured.
  it('names a file that wanted more memory than the worker was given', () => {
    const error = classifyWorkerError(
      new Error('Worker terminated due to reaching memory limit: JS heap out of memory'),
      512,
    );
    expect(error).toBeInstanceOf(ExtractError);
    expect((error as ExtractError).code).toBe('too-large');
    expect(error.message).toContain('512 MB');
  });

  it('refuses to blame the file when it is the worker that could not start', () => {
    // An image built without `dist/learning/extract/worker.js`, or a partial
    // deploy: the server is broken, and telling an operator their perfectly
    // good document is corrupt sends them to look in the wrong place — with a
    // 400, which says the request was at fault. This is the one case that is
    // *not* an ExtractError, so it surfaces as a 500 and reaches the log.
    const error = classifyWorkerError(
      new Error("Cannot find module 'D:/opt/app/dist/learning/extract/worker.js'"),
      512,
    );
    expect(error).not.toBeInstanceOf(ExtractError);
    expect(error.message).toMatch(/worker/i);
    expect((error as { statusCode?: number }).statusCode).toBeUndefined();
  });

  it('calls a genuine reading failure a broken file, and keeps what happened', () => {
    const error = classifyWorkerError(new Error('Unexpected end of archive'), 512);
    expect(error).toBeInstanceOf(ExtractError);
    expect((error as ExtractError).code).toBe('corrupt');
    expect(error.message).toContain('Unexpected end of archive');
  });
});

describe('InProcessExtractor', () => {
  it('does the same work without a thread', async () => {
    const input = { name: 'sample.md', mime: '', data: fixture('sample.md') };
    expect(await new InProcessExtractor().extract(input)).toEqual(await extractInProcess(input));
  });
});

if (!built) {
  it('says why the worker cases did not run', () => {
    console.warn(
      'WorkerExtractor cases skipped: apps/api/dist is not built. Run `pnpm --filter @metaclaude/api build`; CI builds before it tests.',
    );
    expect(built).toBe(false);
  });
}
