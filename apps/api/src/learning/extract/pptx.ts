/**
 * Slide decks, read straight out of the OOXML.
 *
 * No library, and that is a considered choice rather than a saving: what a
 * deck needs is the slide order, the title placeholder, the body paragraphs,
 * the tables and the speaker notes — five queries against a zip of XML — and
 * the npm packages that offer it either render decks (megabytes of layout
 * code) or flatten every slide into one string, losing exactly the structure
 * a citation needs.
 *
 * Two things are less obvious than they look:
 *
 * **The order is not the file names.** `slide3.xml` is wherever
 * `presentation.xml` puts it; a deck reordered after authoring keeps its
 * original file names. So the order comes from the `<p:sldId>` list resolved
 * through the relationship file.
 *
 * **The notes are the reasons.** A slide says "Fenêtre : dimanche 03h–05h";
 * its notes say who agreed to it and when. Dropping them keeps the claims and
 * loses the arguments.
 */

import { strFromU8, unzipSync } from 'fflate';
import type { KnowledgePageUnit } from '@metaclaude/shared';

import { ExtractError } from './errors.js';
import { joinPages, rowsToParagraphs, type ExtractedText, type ExtractInput } from './types.js';

export const PPTX_EXTRACTOR = 'pptx@1';
const SLIDE: KnowledgePageUnit = 'slide';

/**
 * The largest a single zip entry may claim to be.
 *
 * A deck is images and XML; 64 MiB of *one* entry is not a deck, it is a
 * decompression bomb. `fflate`'s filter is checked against the declared size
 * before anything is inflated, so this costs nothing on an honest file.
 */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

const XML_ENTITIES: Record<string, string> = {
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

const decode = (text: string): string =>
  text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, digits: string) => String.fromCodePoint(Number(digits)))
    .replace(/&(lt|gt|quot|apos);/g, (_, name: string) => XML_ENTITIES[name]!)
    // Last, so `&amp;lt;` stays a literal `&lt;`.
    .replace(/&amp;/g, '&');

/** The text of every `<a:p>` in a fragment, one string per paragraph. */
function paragraphsOf(xml: string): string[] {
  return [...xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)]
    .map((paragraph) =>
      [...paragraph[1]!.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>|<a:br\s*\/>/g)]
        .map((run) => (run[0].startsWith('<a:br') ? '\n' : decode(run[1]!)))
        .join('')
        .trim(),
    )
    .filter((text) => text !== '');
}

/** id → target, tolerating either attribute order. */
function relationships(xml: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of xml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]+)"/.exec(match[0])?.[1];
    const target = /\bTarget="([^"]+)"/.exec(match[0])?.[1];
    if (id && target) found.set(id, target);
  }
  return found;
}

/** `../slides/slide1.xml` relative to `ppt/` becomes `ppt/slides/slide1.xml`. */
const underPpt = (target: string): string => `ppt/${target.replace(/^(\.\.\/)+/, '')}`;

export function extractPptx(input: ExtractInput): ExtractedText {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(input.data), {
      filter: (file) => file.originalSize <= MAX_ENTRY_BYTES,
    });
  } catch (error) {
    throw new ExtractError(
      'corrupt',
      `This presentation could not be read (${(error as Error).message}).`,
    );
  }

  const read = (path: string): string => (files[path] ? strFromU8(files[path]!) : '');

  const presentation = read('ppt/presentation.xml');
  if (!presentation) {
    // A .docx renamed .pptx unzips perfectly and has none of this.
    throw new ExtractError('corrupt', 'This file is a zip, but not a presentation.');
  }

  const rels = relationships(read('ppt/_rels/presentation.xml.rels'));
  const slidePaths = [...presentation.matchAll(/<p:sldId\b[^>]*r:id="([^"]+)"/g)]
    .map((match) => rels.get(match[1]!))
    .filter((target): target is string => target !== undefined)
    .map(underPpt);

  const slides = slidePaths.map((path, index) => {
    const xml = read(path);
    const shapes = [...xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)].map((match) => match[0]);

    let title = '';
    const body: string[] = [];
    const loose: string[][] = [];
    for (const shape of shapes) {
      const paragraphs = paragraphsOf(shape);
      if (paragraphs.length === 0) continue;
      if (!title && /<p:ph\b[^>]*type="(?:title|ctrTitle)"/.test(shape)) {
        title = paragraphs.join(' ');
      } else {
        loose.push(paragraphs);
      }
    }
    // A deck built by dragging text boxes around has no title placeholder at
    // all — and its first line is its title, which is how a person reads it.
    // Promoting it costs nothing if wrong (the text stays in the heading,
    // still indexed) and gives every slide a section to be cited under.
    if (!title && loose.length > 0) title = loose[0]!.shift() ?? '';
    for (const paragraphs of loose) body.push(...paragraphs);

    // Tables live in a graphic frame, outside every `<p:sp>` — which is why
    // the body scan above is over shapes and not over the whole slide: a
    // whole-slide scan would take each cell twice, once loose and once here.
    for (const table of xml.matchAll(/<a:tbl\b[\s\S]*?<\/a:tbl>/g)) {
      const rows = [...table[0].matchAll(/<a:tr\b[\s\S]*?<\/a:tr>/g)].map((row) =>
        [...row[0].matchAll(/<a:tc\b[\s\S]*?<\/a:tc>/g)].map((cell) =>
          paragraphsOf(cell[0]).join(' '),
        ),
      );
      const rendered = rowsToParagraphs(rows);
      if (rendered) body.push(rendered);
    }

    const notesTarget = /Target="([^"]*notesSlide\d+\.xml)"/.exec(
      read(path.replace(/slides\/(slide\d+\.xml)$/, 'slides/_rels/$1.rels')),
    )?.[1];
    if (notesTarget) {
      const notes = [...read(underPpt(notesTarget)).matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)]
        .map((match) => match[0])
        .filter((shape) => /<p:ph\b[^>]*type="body"/.test(shape))
        .flatMap(paragraphsOf);
      if (notes.length > 0) body.push(`Notes: ${notes.join(' ')}`);
    }

    // `Slide`, in English, and it is the only word this file invents: every
    // other extractor names a section after something the document already
    // carries — a sheet's name, a file's name, a heading — and a deck's
    // slides have no names of their own. The word has to match the one the
    // citation uses, because both land in the same prompt: `describeLocation`
    // writes `(slide 3, lines 4–9)` directly above this heading, and a model
    // shown `Diapositive 3` under `slide 3` has no way to tell they are one
    // slide. See the case in pptx.test.ts, which derives it from the locator.
    const heading = `## Slide ${index + 1}${title ? ` — ${title}` : ''}`;
    return [heading, ...body].join('\n\n');
  });

  if (slides.length === 0) {
    throw new ExtractError('no-text', 'This presentation has no slides in it.');
  }

  return { ...joinPages(slides), pageUnit: SLIDE, extractor: PPTX_EXTRACTOR };
}
