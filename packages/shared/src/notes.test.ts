/**
 * Wikilink mechanics — the contract both the API index and the web preview
 * stand on. A divergence here is a click that opens a different note than
 * the graph drew, so the rules live in one module and are pinned here.
 */

import { describe, expect, it } from 'vitest';
import { extractWikilinks, resolveLink } from './notes.js';

/* ------------------------------------------------------------------------ */
/* extractWikilinks                                                          */
/* ------------------------------------------------------------------------ */

describe('extractWikilinks', () => {
  it('reads targets through aliases and heading anchors', () => {
    const links = extractWikilinks('See [[Widget]] and [[Gadget|the gadget]] and [[Specs#Power]].');
    expect(links).toEqual(['Widget', 'Gadget', 'Specs']);
  });

  it('ignores links inside code fences and inline code', () => {
    const text = [
      'Real: [[Alpha]]',
      '```',
      'Not real: [[Beta]]',
      '```',
      'Inline `[[Gamma]]` is prose too.',
      '~~~text',
      '[[Delta]]',
      '~~~',
    ].join('\n');
    expect(extractWikilinks(text)).toEqual(['Alpha']);
  });

  it('ignores empty and embed-style targets it cannot resolve to notes', () => {
    expect(extractWikilinks('[[]] and [[ ]] stay out; ![[image.png]] is an embed.')).toEqual([
      'image.png',
    ]);
  });
});

/* ------------------------------------------------------------------------ */
/* resolveLink                                                               */
/* ------------------------------------------------------------------------ */

describe('resolveLink', () => {
  const paths = [
    'Widget.md',
    'projects/Widget.md',
    'projects/deep/Gadget.md',
    'notes/reference.md',
  ];

  it('matches a bare name case-insensitively', () => {
    expect(resolveLink('gadget', 'Widget.md', paths)).toBe('projects/deep/Gadget.md');
  });

  it('prefers a note in the same folder, then the shortest path', () => {
    expect(resolveLink('Widget', 'projects/Widget.md', paths)).toBe('projects/Widget.md');
    expect(resolveLink('Widget', 'notes/reference.md', paths)).toBe('Widget.md');
  });

  it('resolves an explicit relative path when one is written', () => {
    expect(resolveLink('projects/Widget', 'notes/reference.md', paths)).toBe(
      'projects/Widget.md',
    );
  });

  it('answers null for a note that does not exist', () => {
    expect(resolveLink('Missing', 'Widget.md', paths)).toBeNull();
  });
});

