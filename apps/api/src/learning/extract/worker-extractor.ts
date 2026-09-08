/**
 * Extraction, bounded.
 *
 * Not for latency: a 300-page PDF is read in well under a second, and a
 * 40 000-row spreadsheet in half of one. It is for the file that is not
 * ordinary — a zip bomb inside a .docx, a PDF with three thousand pages, a
 * malformed stream that sends a parser round a loop. The API supervises live
 * runs and serves a websocket; an extraction that pauses the event loop for a
 * minute is an outage, and one that exhausts the heap is a restart.
 *
 * Measured in a worker capped at 512 MB: 300 pages peak at 64 MB, 1 000 pages
 * at 139 MB, 3 000 pages at 290 MB — a factor of ten over the largest
 * document the library will accept. Under a 64 MB cap the same file is killed
 * and the parent is told, which is the behaviour this class exists to turn
 * into a sentence an operator can read.
 */

import { Worker } from 'node:worker_threads';

import { ExtractError } from './errors.js';
import { extractInProcess } from './index.js';
import type { ExtractedText, ExtractInput } from './types.js';
import type { WorkerResponse } from './worker.js';

export interface Extractor {
  extract(input: ExtractInput): Promise<ExtractedText>;
}

export interface WorkerExtractorOptions {
  timeoutMs?: number;
  maxOldGenerationSizeMb?: number;
  /**
   * Where the worker's *built* entry point is.
   *
   * The default is right in every deployment: `dist/learning/extract/worker.js`
   * beside the file that spawns it. It is an option because under vitest this
   * module is loaded from `src`, where the neighbour is TypeScript that Node
   * will not run — so the test points at `dist` and drives the real class
   * against the real worker, rather than replacing either with a double.
   */
  workerUrl?: URL;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_HEAP_MB = 512;

/**
 * What a thread that died is trying to say.
 *
 * Its own function so the branch is provable: actually exhausting a worker's
 * heap inside a test takes the *test runner's* pool down with it, so what can
 * be asserted is the translation, and it is the translation that matters. An
 * operator sent looking for a corrupt file, about a 3 000-page PDF that is
 * perfectly valid, would look in the wrong place all day.
 *
 * Measured: a worker over its cap arrives on the `error` event with
 * "Worker terminated due to reaching memory limit: JS heap out of memory",
 * and exits afterwards.
 */
export function classifyWorkerError(error: Error, heapMb: number): ExtractError {
  if (/memory limit/i.test(error.message)) {
    return new ExtractError(
      'too-large',
      `This file needs more than ${heapMb} MB to read. Split it, or keep the part the agent needs.`,
    );
  }
  return new ExtractError('corrupt', `Extraction failed: ${error.message}`);
}

export class WorkerExtractor implements Extractor {
  constructor(private readonly options: WorkerExtractorOptions = {}) {}

  extract(input: ExtractInput): Promise<ExtractedText> {
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const heapMb = this.options.maxOldGenerationSizeMb ?? DEFAULT_HEAP_MB;

    return new Promise<ExtractedText>((resolve, reject) => {
      // `dist/learning/extract/worker.js` beside this file. Resolved from
      // `import.meta.url` rather than from the process's directory, so it is
      // right whatever the working directory a deployment starts in.
      const worker = new Worker(this.options.workerUrl ?? new URL('./worker.js', import.meta.url), {
        workerData: { name: input.name, mime: input.mime, data: input.data },
        resourceLimits: { maxOldGenerationSizeMb: heapMb },
      });

      let settled = false;
      /**
       * Settle once, and stop the thread.
       *
       * The termination is not observable in a unit test — any file small
       * enough to commit finishes on its own before a check could run, and a
       * test claiming to prove it would be a test that proves nothing. It is
       * here for the case the timeout exists for: a file that is *still
       * working* when we give up on it, where the thread would otherwise keep
       * a core busy for as long as it likes, once per hostile upload.
       */
      const finish = (act: () => void): void => {
        if (settled) return;
        settled = true;
        act();
        void worker.terminate();
      };

      const timer = setTimeout(
        () =>
          finish(() =>
            reject(
              new ExtractError(
                'timeout',
                `Reading this file gave up after ${Math.round(timeoutMs / 1000)} s.`,
              ),
            ),
          ),
        timeoutMs,
      );

      worker.once('message', (message: WorkerResponse) => {
        clearTimeout(timer);
        finish(() =>
          message.ok ? resolve(message.out) : reject(new ExtractError(message.code, message.message)),
        );
      });

      worker.once('error', (error: Error) => {
        clearTimeout(timer);
        finish(() => reject(classifyWorkerError(error, heapMb)));
      });

      worker.once('exit', (code) => {
        clearTimeout(timer);
        // Only reached when the thread died without saying anything: a
        // successful run has already settled on its message.
        finish(() =>
          reject(new ExtractError('timeout', `Extraction stopped unexpectedly (exit ${code}).`)),
        );
      });
    });
  }
}

/**
 * The same work, on this thread.
 *
 * For tests and benches, and for the one caller that genuinely wants it: a
 * script whose only job is the extraction has nothing to protect. Injected
 * rather than chosen at runtime, so nothing decides silently between the two.
 */
export class InProcessExtractor implements Extractor {
  extract(input: ExtractInput): Promise<ExtractedText> {
    return extractInProcess(input);
  }
}
