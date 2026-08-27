/**
 * Markdown rendering and sanitisation.
 *
 * Everything rendered through `renderMarkdown` is model output, and model
 * output can quote whatever the model read from a repository. That makes this
 * the one place in the app where a hostile string reaches `innerHTML`, so the
 * tests below are written as attacks rather than as feature checks.
 */

import { describe, expect, it } from 'vitest';
import { parseDiff, renderMarkdown, renderNoteMarkdown } from './markdown.js';

/** True when the rendered output contains no executable or fetching surface. */
function isInert(html: string): boolean {
  const lowered = html.toLowerCase();
  return (
    !lowered.includes('<script') &&
    !lowered.includes('<iframe') &&
    !lowered.includes('<object') &&
    !lowered.includes('<embed') &&
    !lowered.includes('<img') &&
    !lowered.includes('<svg') &&
    !/\son[a-z]+\s*=/.test(lowered) &&
    !lowered.includes('javascript:') &&
    !lowered.includes('data:text/html')
  );
}

describe('renderMarkdown — script injection', () => {
  const attacks = [
    '<script>alert(1)</script>',
    '<ScRiPt>alert(1)</ScRiPt>',
    '<img src=x onerror=alert(1)>',
    '<svg/onload=alert(1)>',
    '<iframe src="https://evil.example"></iframe>',
    '<object data="https://evil.example"></object>',
    '<embed src="https://evil.example">',
    '<body onload=alert(1)>',
    '<a href="javascript:alert(1)">click</a>',
    '<div style="background:url(javascript:alert(1))">x</div>',
    '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
    '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
    '<form action="https://evil.example"><input name=a></form>',
  ];

  for (const attack of attacks) {
    it(`neutralises ${attack.slice(0, 42)}`, () => {
      expect(isInert(renderMarkdown(attack))).toBe(true);
    });
  }
});

describe('renderMarkdown — link URLs', () => {
  it('renders an ordinary link', () => {
    const html = renderMarkdown('[docs](https://example.com/a)');
    expect(html).toContain('href="https://example.com/a"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  it('keeps the label but drops the link for a dangerous scheme', () => {
    for (const href of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
    ]) {
      const html = renderMarkdown(`[label](${href})`);
      expect(html).toContain('label');
      expect(html).not.toContain('href=');
      expect(isInert(html)).toBe(true);
    }
  });

  it('rejects a scheme hidden behind control characters', () => {
    // `java\tscript:` and friends are re-joined by the URL parser but would
    // sail past a naive prefix test.
    for (const href of ['java\tscript:alert(1)', 'java\nscript:alert(1)', ' javascript:alert(1)']) {
      const html = renderMarkdown(`[x](${href})`);
      expect(html).not.toContain('href=');
    }
  });

  it('allows relative and anchor targets', () => {
    expect(renderMarkdown('[a](/local/path)')).toContain('href="/local/path"');
    expect(renderMarkdown('[a](#section)')).toContain('href="#section"');
    expect(renderMarkdown('[a](./sibling)')).toContain('href="./sibling"');
    expect(renderMarkdown('[a](mailto:me@example.com)')).toContain('href="mailto:me@example.com"');
  });

  it('renders inline markup inside a link label rather than its source', () => {
    // The link token's `text` is raw source; emitting it directly would print
    // `*emphasis*` literally and paste any HTML in the label into the document.
    const html = renderMarkdown('[*emphasis* and `code`](https://example.com)');
    expect(html).toContain('<em>emphasis</em>');
    expect(html).toContain('<code>code</code>');
    expect(html).not.toContain('*emphasis*');
  });

  it('does not let a label smuggle markup through, with or without a valid href', () => {
    for (const source of [
      '[<img src=x onerror=alert(1)>](https://example.com)',
      '[<img src=x onerror=alert(1)>](javascript:alert(1))',
    ]) {
      expect(isInert(renderMarkdown(source))).toBe(true);
    }
  });
});

describe('renderMarkdown — images', () => {
  it('never emits an <img>, since that is a request to an arbitrary host', () => {
    const html = renderMarkdown('![alt text](https://tracker.example/pixel.png)');
    expect(html).not.toContain('<img');
    expect(html).toContain('alt text');
  });

  it('escapes the alt text', () => {
    expect(isInert(renderMarkdown('![<script>alert(1)</script>](https://x.example/a.png)'))).toBe(
      true,
    );
  });
});

describe('renderMarkdown — ordinary content survives', () => {
  it('renders headings, lists, emphasis and tables', () => {
    const html = renderMarkdown(
      ['# Title', '', '- one', '- two', '', '**bold** and *italic*', '', '| a | b |', '| - | - |', '| 1 | 2 |'].join('\n'),
    );
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<table>');
  });

  it('escapes code blocks instead of interpreting them', () => {
    const html = renderMarkdown('```html\n<script>alert(1)</script>\n```');
    expect(html).toContain('class="language-html"');
    expect(html).toContain('&lt;script&gt;');
    expect(isInert(html)).toBe(true);
  });

  it('returns an empty string for empty input and never throws', () => {
    expect(renderMarkdown('')).toBe('');
    expect(() => renderMarkdown('[unclosed](')).not.toThrow();
    expect(() => renderMarkdown('#'.repeat(5000))).not.toThrow();
  });
});

describe('renderNoteMarkdown — wikilinks', () => {
  const resolve = (target: string) =>
    target.toLowerCase() === 'widget' ? 'notes/Widget.md' : null;

  it('renders a resolved wikilink as an in-app link carrying its path', () => {
    const html = renderNoteMarkdown('Go read [[Widget]].', resolve);
    expect(html).toContain('data-note="notes/Widget.md"');
    expect(html).toContain('class="wikilink"');
    expect(html).toContain('>Widget</a>');
  });

  it('shows the alias and keeps the target', () => {
    const html = renderNoteMarkdown('See [[Widget|the widget note]].', resolve);
    expect(html).toContain('>the widget note</a>');
    expect(html).toContain('data-note="notes/Widget.md"');
  });

  it('marks an unresolved wikilink instead of linking nowhere', () => {
    const html = renderNoteMarkdown('See [[Missing]].', resolve);
    expect(html).not.toContain('<a');
    expect(html).toContain('wikilink-missing');
    expect(html).toContain('Missing');
  });

  it('leaves wikilinks inside code alone', () => {
    const html = renderNoteMarkdown('Use `[[Widget]]` syntax:\n\n```\n[[Widget]]\n```', resolve);
    expect(html).not.toContain('data-note');
  });

  it('still sanitises everything else', () => {
    const html = renderNoteMarkdown('[[Widget]] <script>alert(1)</script>', resolve);
    expect(html).not.toContain('<script');
  });

  it('never leaks into the transcript renderer', () => {
    const html = renderMarkdown('See [[Widget]].');
    expect(html).not.toContain('data-note');
    expect(html).toContain('[[Widget]]');
  });
});

describe('parseDiff', () => {
  const diff = [
    'diff --git a/x.ts b/x.ts',
    'index 1111111..2222222 100644',
    '--- a/x.ts',
    '+++ b/x.ts',
    '@@ -3,4 +3,5 @@ function f() {',
    ' const a = 1;',
    '-const b = 2;',
    '+const b = 3;',
    '+const c = 4;',
    ' return a;',
  ].join('\n');

  it('classifies each line and tracks both line numbers', () => {
    const lines = parseDiff(diff);
    const kinds = lines.map((line) => line.type);
    expect(kinds.filter((k) => k === 'add')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'remove')).toHaveLength(1);
    expect(kinds).toContain('hunk');
    expect(kinds).toContain('meta');

    const context = lines.find((line) => line.type === 'context');
    expect(context?.oldLine).toBe(3);
    expect(context?.newLine).toBe(3);

    const removed = lines.find((line) => line.type === 'remove');
    expect(removed?.oldLine).toBe(4);
    expect(removed?.newLine).toBeNull();

    const added = lines.filter((line) => line.type === 'add');
    expect(added[0]?.newLine).toBe(4);
    expect(added[1]?.newLine).toBe(5);
    expect(added[0]?.oldLine).toBeNull();
  });

  it('handles an empty diff and a malformed hunk header', () => {
    // No hunk header means no line origin, so the counters stay at zero.
    expect(parseDiff('')).toEqual([{ type: 'context', text: '', oldLine: 0, newLine: 0 }]);
    expect(() => parseDiff('@@ nonsense @@\n+x')).not.toThrow();
  });
});
