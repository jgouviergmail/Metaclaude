/**
 * Why a file could not become a document, in words an operator can act on.
 *
 * Every refusal names its cause and what to do about it. "Extraction failed"
 * is the one message this module exists to prevent: a person who dropped a
 * scanned PDF needs to be told it is a scan, not that something went wrong.
 *
 * The status code travels with the code because the route has no better way
 * to choose one — 415 for a type nobody reads, 413 for too much text, 422 for
 * a file that is the right type and still yields nothing.
 */

export type ExtractErrorCode =
  /** No extractor for this type. */
  | 'unsupported'
  /** Zero bytes. */
  | 'empty'
  /** The right type, and unreadable — truncated, or not what its name says. */
  | 'corrupt'
  /** Readable, and sealed. */
  | 'encrypted'
  /** Readable, and carries no text: a scan. */
  | 'no-text'
  /** More text than a document may hold. */
  | 'too-large'
  /** Took too long, or needed more memory than a worker is given. */
  | 'timeout';

const STATUS: Record<ExtractErrorCode, number> = {
  unsupported: 415,
  empty: 400,
  corrupt: 400,
  encrypted: 422,
  'no-text': 422,
  'too-large': 413,
  timeout: 422,
};

export class ExtractError extends Error {
  readonly statusCode: number;

  constructor(
    readonly code: ExtractErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ExtractError';
    this.statusCode = STATUS[code];
  }
}
