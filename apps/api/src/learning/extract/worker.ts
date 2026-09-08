/**
 * One extraction, in a thread of its own.
 *
 * The entry point `WorkerExtractor` spawns. It does exactly one job and dies,
 * which is what makes the resource limits meaningful: a file that needs more
 * memory than it is given kills this thread and nothing else.
 *
 * Errors cross the thread boundary as a code and a message rather than as an
 * `Error` — structured cloning would carry the class but not its prototype
 * chain, so `instanceof ExtractError` on the other side would be false and
 * every refusal would read as an internal failure.
 */

import { parentPort, workerData } from 'node:worker_threads';

import { ExtractError, type ExtractErrorCode } from './errors.js';
import { extractInProcess } from './index.js';
import type { ExtractedText } from './types.js';

export type WorkerRequest = { name: string; mime: string; data: Uint8Array };
export type WorkerResponse =
  | { ok: true; out: ExtractedText }
  | { ok: false; code: ExtractErrorCode; message: string };

const request = workerData as WorkerRequest;

void extractInProcess({
  name: request.name,
  mime: request.mime,
  data: Buffer.from(request.data),
}).then(
  (out) => parentPort?.postMessage({ ok: true, out } satisfies WorkerResponse),
  (error: unknown) =>
    parentPort?.postMessage({
      ok: false,
      // Anything that is not a refusal we recognise is a broken file as far as
      // the operator is concerned; the message still carries what happened.
      code: error instanceof ExtractError ? error.code : 'corrupt',
      message: (error as Error)?.message ?? 'Extraction failed.',
    } satisfies WorkerResponse),
);
