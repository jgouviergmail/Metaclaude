/**
 * PDFs, through poppler where it is installed and pdfjs where it is not.
 *
 * A PDF's content stream carries no reading order — the format places glyphs,
 * and nothing in it says that this column continues into that one — so which
 * engine reads it is a decision with consequences, and it was measured rather
 * than assumed. Both engines were run over two real two-column papers (arXiv
 * 1512.03385, ACL 2020.acl-main.1) and a LaTeX `twocolumn` document, inside
 * the image this product ships:
 *
 *                        poppler 22.12    pdfjs 6.3
 *   words broken by a
 *   line-end hyphen           0            10 to 165 per document
 *   probe phrases found      12/12        11/12
 *   one page, 300 pages      5 to 42 ms   10 to 457 ms
 *
 * **Hyphenation is the difference that matters.** Poppler rejoins a word its
 * typesetter split across two lines; pdfjs hands over `learn-\ning`, which no
 * query for "learning residual functions" will match and which the embedder
 * sees as two words that are not words. 165 of them on one paper, and one of
 * four probe phrases genuinely unfindable.
 *
 * Reading *order* is not the difference, and an earlier version of this file
 * said it was. Grouping items by baseline — a `Map` keyed on rounded y —
 * does interleave two columns; reading them in content-stream order, which is
 * what `linesOf` below does, does not, on any of the three documents. The
 * claim came from a probe that grouped, and the code that shipped does not.
 *
 * So poppler is the engine, in a subprocess — isolation for free, and bounded
 * — and pdfjs stays as a **named** fallback for a development machine without
 * it. Named, because `extractor` is what the doctor reports and what the
 * re-extract button acts on: a document read by the weaker engine has to be
 * findable, not silently different.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

import { ExtractError } from './errors.js';
import { joinPages, type ExtractedText, type ExtractInput } from './types.js';

const require = createRequire(import.meta.url);
/** pdfjs needs its own font metrics on disk for a document with no embedded fonts. */
const STANDARD_FONTS = require
  .resolve('pdfjs-dist/package.json')
  .replace(/package\.json$/, 'standard_fonts/');

/** How long one PDF may take, and how much of its text may be buffered. */
const TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** Page texts, best-effort in reading order, and the engine's name. */
export interface PdfEngine {
  pages(data: Buffer): Promise<string[]>;
  readonly name: string;
}

/**
 * poppler's `pdftotext`, over a pipe.
 *
 * `spawn` rather than `execFile`: the bytes go in on stdin, which `execFile`
 * cannot do (only its sync twin takes `input`), and stdout is capped by hand
 * so a PDF whose text is unbounded is stopped rather than buffered whole.
 */
export class PopplerEngine implements PdfEngine {
  readonly name: string;

  constructor(
    private readonly binary = 'pdftotext',
    version: string | null = popplerVersion(binary),
  ) {
    this.name = `pdf@poppler-${version ?? 'unknown'}`;
  }

  pages(data: Buffer): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, ['-enc', 'UTF-8', '-', '-'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const chunks: Buffer[] = [];
      let size = 0;
      let stderr = '';
      let settled = false;

      const fail = (error: ExtractError): void => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(error);
      };

      const timer = setTimeout(
        () => fail(new ExtractError('timeout', `Reading this PDF gave up after ${TIMEOUT_MS / 1000} s.`)),
        TIMEOUT_MS,
      );

      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_OUTPUT_BYTES) {
          fail(new ExtractError('too-large', 'The text of this PDF exceeds what a document may hold.'));
        } else {
          chunks.push(chunk);
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      child.on('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        fail(
          new ExtractError(
            'corrupt',
            error.code === 'ENOENT'
              ? 'pdftotext is not installed on this host.'
              : `pdftotext could not be run: ${error.message}`,
          ),
        );
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        if (code !== 0) {
          if (/incorrect password/i.test(stderr)) {
            reject(new ExtractError('encrypted', 'This PDF is password-protected.'));
            return;
          }
          const detail = stderr.trim().split('\n').pop() ?? `exit ${code}`;
          reject(new ExtractError('corrupt', `This PDF could not be read (${detail}).`));
          return;
        }
        // pdftotext ends every page with a form feed, the last one included.
        resolve(Buffer.concat(chunks).toString('utf8').replace(/\f$/, '').split('\f'));
      });

      // EPIPE when the child refused the file before reading it all: `close`
      // carries the verdict, and an unhandled error event would not.
      child.stdin.on('error', () => undefined);
      child.stdin.end(data);
    });
  }
}

/**
 * pdfjs — the fallback.
 *
 * Kept because a development machine without poppler must still be able to
 * read a PDF, and because "no engine at all" is a worse answer than "a weaker
 * engine, and the document says which".
 *
 * Weaker in one measured way: it hands over the glyphs, so a word its
 * typesetter split across two lines arrives split. `rejoinHyphens` closes
 * most of that gap; what it cannot do is tell a typesetter's hyphen from a
 * real one, which is why poppler — who knows the layout — remains the engine
 * that ships.
 */
export class PdfjsEngine implements PdfEngine {
  readonly name = 'pdf@pdfjs';

  async pages(data: Buffer): Promise<string[]> {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    // No `isEvalSupported`: pdfjs 6 dropped it from DocumentInitParameters.
    const task = pdfjs.getDocument({
      data: new Uint8Array(data),
      standardFontDataUrl: STANDARD_FONTS,
      disableFontFace: true,
      useSystemFonts: false,
      verbosity: 0,
    });

    try {
      const pdf = await task.promise.catch((error: Error) => {
        if (error.name === 'PasswordException') {
          throw new ExtractError('encrypted', 'This PDF is password-protected.');
        }
        throw new ExtractError('corrupt', `This PDF could not be read (${error.message}).`);
      });

      const pages: string[] = [];
      for (let number = 1; number <= pdf.numPages; number += 1) {
        const page = await pdf.getPage(number);
        const content = await page.getTextContent();
        // NFKC folds the ligature glyphs a font without a Unicode table leaves
        // behind, so "notiﬁé" is findable by searching for "notifié".
        pages.push(rejoinHyphens(linesOf(content.items).normalize('NFKC')));
        page.cleanup();
      }
      return pages;
    } finally {
      await task.destroy();
    }
  }
}

/**
 * Rejoin a word a typesetter split across two lines.
 *
 * Measured on two real papers: 165 and 113 such words respectively, each one
 * a word no lexical query can match and a token the embedder sees as
 * meaningless. Poppler does this itself.
 *
 * The trade it makes, stated rather than hidden: a *genuinely* hyphenated
 * word that happens to break at its hyphen — `porte-\nmanteau` — is joined
 * into one word too. That is one word wrong against a hundred and sixty-five
 * made right, and the rule is deliberately narrow: lowercase letter, hyphen,
 * newline, lowercase letter. A capital after the break, which is how a line
 * ending in a dash before a proper noun looks, is left alone.
 */
export function rejoinHyphens(text: string): string {
  return text.replace(/(\p{Ll})-\n(\p{Ll})/gu, '$1$2');
}

/** Items grouped into lines by baseline; a gap of more than two points is a new line. */
function linesOf(items: readonly unknown[]): string {
  const lines: string[] = [];
  let line: string[] = [];
  let lastY: number | null = null;

  for (const item of items as Array<{ str?: string; transform?: number[]; hasEOL?: boolean }>) {
    if (typeof item.str !== 'string' || !item.transform) continue;
    const y = Math.round(item.transform[5] ?? 0);
    if (lastY !== null && Math.abs(y - lastY) > 2) {
      lines.push(line.join(''));
      line = [];
    }
    line.push(item.str);
    if (item.hasEOL) {
      lines.push(line.join(''));
      line = [];
      lastY = null;
      continue;
    }
    lastY = y;
  }
  if (line.length > 0) lines.push(line.join(''));
  return lines.join('\n');
}

/**
 * poppler's version, or null when *poppler* is not there.
 *
 * The name `pdftotext` is not poppler's alone: xpdf ships a binary with the
 * same name, the same `-v` banner shape and a different command line — it
 * takes no `-` for stdin, so every extraction would fail with "could not be
 * read" on a host where xpdf happens to be first on PATH. Measured on this
 * project's Windows development machine, where Git and MiKTeX both install
 * one.
 *
 * A version number cannot separate them (xpdf is at 4.x, poppler at 22.x, and
 * neither promises to stay there), so the discriminator is the copyright
 * line poppler prints and xpdf does not:
 *
 *     pdftotext version 22.12.0
 *     Copyright 2005-2022 The Poppler Developers - http://poppler.freedesktop.org
 *
 * Synchronous, and called once per engine: at construction and at boot, never
 * per document. An async probe would make every caller of `defaultPdfEngine`
 * async for a value that cannot change while the process lives.
 */
export function popplerVersion(binary = 'pdftotext'): string | null {
  try {
    const probe = spawnSync(binary, ['-v'], { encoding: 'utf8', timeout: 5_000 });
    if (probe.error) return null;
    // pdftotext prints its banner on stderr; read both, cheaply.
    const banner = `${probe.stderr ?? ''}${probe.stdout ?? ''}`;
    if (!/poppler/i.test(banner)) return null;
    return /pdftotext\s+version\s+(\S+)/i.exec(banner)?.[1] ?? null;
  } catch {
    return null;
  }
}

export const popplerAvailable = (binary = 'pdftotext'): boolean => popplerVersion(binary) !== null;

/** poppler where it is installed, pdfjs where it is not. */
export function defaultPdfEngine(): PdfEngine {
  const version = popplerVersion();
  return version === null ? new PdfjsEngine() : new PopplerEngine('pdftotext', version);
}

export async function extractPdf(
  input: ExtractInput,
  engine: PdfEngine = defaultPdfEngine(),
): Promise<ExtractedText> {
  const pages = await engine.pages(input.data);
  if (pages.every((page) => page.trim() === '')) {
    throw new ExtractError(
      'no-text',
      'This PDF has no text layer — it is a scan, and reading one needs OCR, which is not supported.',
    );
  }
  // No heading is invented: a PDF has pages, not sections, and a passage of
  // one is cited by its page.
  return { ...joinPages(pages), pageUnit: 'page', extractor: engine.name };
}
