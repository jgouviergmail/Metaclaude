/**
 * HTML into the Markdown the chunker sections on.
 *
 * Two callers, and the second is why this is careful: a `.html` an operator
 * drops, and every `.docx`, which mammoth hands over as HTML. So the tags
 * that carry structure — headings, lists, tables — have to survive as
 * structure, and the tags that carry a page's furniture have to go.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { htmlToMarkdown } from './html.js';

const wild = readFileSync(new URL('./fixtures/sample.html', import.meta.url), 'utf8');

describe('htmlToMarkdown', () => {
  it('turns headings and lists into the markdown the chunker sections on', () => {
    const markdown = htmlToMarkdown(wild);
    expect(markdown).toContain('# Runbook & conventions');
    expect(markdown).toContain('## Étapes');
    expect(markdown).toContain('- Construire');
  });

  it('gives every table row its own paragraph, so a row is never split in two', () => {
    // The chunker packs paragraphs; a table written as one blob would be cut
    // mid-row, and half a row is a passage that says something untrue.
    expect(htmlToMarkdown('<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>')).toBe(
      '| a | b |\n\n| c | d |',
    );
    expect(htmlToMarkdown(wild)).toContain('| timeout | 30 s |');
  });

  it('keeps a table header row, which is what names the columns below it', () => {
    expect(htmlToMarkdown(wild)).toContain('| Clé | Valeur |');
  });

  it('drops scripts, styles, navigation and the footer', () => {
    const markdown = htmlToMarkdown(wild);
    expect(markdown).not.toContain('alert(');
    expect(markdown).not.toContain('color:red');
    expect(markdown).not.toContain('Accueil');
    expect(markdown).not.toContain('© 2026');
  });

  it('decodes the entities a real page uses, numeric and named', () => {
    const markdown = htmlToMarkdown(wild);
    expect(markdown).toContain('été'); // &#233;t&#xE9;
    expect(markdown).toContain('—'); // &mdash;
    expect(markdown).toContain('&'); // &amp;, decoded last so &amp;lt; stays &lt;
    expect(htmlToMarkdown('<p>&amp;lt;</p>')).toBe('&lt;');
  });

  it('keeps a line break inside a paragraph', () => {
    expect(htmlToMarkdown(wild)).toContain('Deuxième ligne.');
    expect(htmlToMarkdown('<p>Un<br>Deux</p>')).toBe('Un\nDeux');
  });

  it('keeps a link readable and carries its address, but only an external one', () => {
    expect(htmlToMarkdown(wild)).toContain('la doc (https://example.com/x)');
    expect(htmlToMarkdown('<a href="/local">ici</a>')).toBe('ici');
    // A javascript: URL is a link nobody should be invited to follow.
    expect(htmlToMarkdown('<a href="javascript:alert(1)">ici</a>')).toBe('ici');
  });

  it('marks emphasis without gluing it to the next word', () => {
    expect(htmlToMarkdown('<p><strong>Important :</strong> le reste.</p>')).toBe(
      '**Important :** le reste.',
    );
    expect(htmlToMarkdown('<p>Tester <em>entièrement</em>.</p>')).toBe('Tester *entièrement*.');
  });

  it('never leaves three blank lines, which would read as an empty paragraph', () => {
    expect(htmlToMarkdown('<div><p>Un</p></div><div><div><p>Deux</p></div></div>')).toBe('Un\n\nDeux');
  });

  it('answers empty for markup that carries no text at all', () => {
    expect(htmlToMarkdown('<html><head><style>a{}</style></head><body></body></html>')).toBe('');
    expect(htmlToMarkdown('')).toBe('');
  });

  it('survives unclosed tags rather than swallowing the rest of the document', () => {
    // Real pages are not well-formed, and an extractor that needs them to be
    // is an extractor that refuses half the web.
    expect(htmlToMarkdown('<p>Un<p>Deux<p>Trois')).toContain('Deux');
  });
});
