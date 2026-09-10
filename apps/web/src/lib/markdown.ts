/**
 * Markdown rendering.
 *
 * Assistant output is model-generated text that may contain anything, including
 * content the model read from a repository. It is therefore treated as
 * untrusted and sanitised with an explicit allow-list before it reaches the DOM.
 *
 * The sanitiser is hand-written rather than imported: the allow-list we need is
 * small and fixed, and a bespoke pass lets us be strict about the two things
 * that actually matter here — no raw HTML passthrough, and no dangerous URLs.
 */

import { marked, Marked, type Renderer, type Tokens } from 'marked';

/** Elements the renderer is allowed to emit. Anything else is escaped. */
const ALLOWED_TAGS = new Set([
  'p', 'br', 'hr', 'strong', 'em', 'del', 'code', 'pre', 'blockquote',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'span', 'div', 'input',
]);

/** Attributes allowed per tag. Everything else is dropped. */
const ALLOWED_ATTRS: Record<string, Set<string>> = {
  // `class` and `data-note` exist for the note preview's wikilinks; both are
  // inert text outside it, so allowing them everywhere costs nothing.
  a: new Set(['href', 'title', 'target', 'rel', 'class', 'data-note']),
  code: new Set(['class']),
  pre: new Set(['class']),
  span: new Set(['class']),
  div: new Set(['class']),
  th: new Set(['align']),
  td: new Set(['align']),
  input: new Set(['type', 'checked', 'disabled']),
  ol: new Set(['start']),
};

/** URL schemes safe to link to. `javascript:` and `data:` are the reason. */
const SAFE_URL = /^(https?:|mailto:|tel:|#|\/|\.{0,2}\/)/i;

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeUrl(url: string): string | null {
  const trimmed = url.trim();
  // Strip control characters first: `java\nscript:` would otherwise slip past.
  const normalised = trimmed.replace(/[\x00-\x20\x7f-\x9f]/g, '');
  return SAFE_URL.test(normalised) ? normalised : null;
}

/* -------------------------------------------------------------------------- */
/* Renderer                                                                    */
/* -------------------------------------------------------------------------- */

const renderer = new marked.Renderer();

/**
 * A link.
 *
 * Written as a `function` so `this.parser` is available: a link token's `text`
 * is the *raw source* of the label, not rendered HTML. Emitting it directly
 * pastes unparsed markdown — `<img src=x onerror=…>` included — straight into
 * the document, which then depends entirely on the post-pass sanitiser to be
 * safe and loses the label's own emphasis and code spans on the way. Running
 * the label's inline tokens back through the parser is what the default
 * renderer does, and it escapes text nodes as it goes.
 */
renderer.link = function link(this: Renderer, token: Tokens.Link): string {
  const label = this.parser.parseInline(token.tokens);
  const url = safeUrl(token.href ?? '');
  // A rejected URL still shows its label, so the reader loses nothing but the click.
  if (!url) return label;
  const titleAttr = token.title ? ` title="${escapeHtml(token.title)}"` : '';
  // `noopener` is what prevents the opened page from reaching back via window.opener.
  return `<a href="${escapeHtml(url)}"${titleAttr} target="_blank" rel="noopener noreferrer nofollow">${label}</a>`;
};

renderer.image = ({ href, title, text }: Tokens.Image): string => {
  // Images are not rendered: an <img> is a request to an arbitrary host, which
  // would leak the fact that this private instance loaded a given transcript.
  const url = safeUrl(href ?? '');
  const label = escapeHtml(title || text || 'image');
  return url
    ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer nofollow">🖼 ${label}</a>`
    : `<span>🖼 ${label}</span>`;
};

renderer.code = ({ text, lang }: Tokens.Code): string => {
  const language = (lang ?? '').split(/\s+/)[0] ?? '';
  const cls = language ? ` class="language-${escapeHtml(language)}"` : '';
  return `<pre><code${cls}>${escapeHtml(text)}</code></pre>`;
};

renderer.html = (): string => {
  // Raw HTML in model output is never rendered. Dropping it entirely is
  // deliberate: escaping it would show markup noise the user did not write.
  return '';
};

marked.setOptions({
  renderer,
  gfm: true,
  breaks: true,
  // The custom renderer already escapes code; `marked`'s own sanitiser is
  // deprecated, so the post-pass below is the real guarantee.
  async: false,
});

/* -------------------------------------------------------------------------- */
/* Sanitiser                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Walk the parsed DOM and remove anything outside the allow-list.
 *
 * Parsing into a detached document (rather than regex-scrubbing a string) means
 * the browser's own parser resolves every ambiguity before we inspect it, which
 * closes the mutation-XSS class of bugs.
 */
function sanitize(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;

  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_ELEMENT);
  const doomed: Element[] = [];

  while (walker.nextNode()) {
    const element = walker.currentNode as Element;
    const tag = element.tagName.toLowerCase();

    if (!ALLOWED_TAGS.has(tag)) {
      doomed.push(element);
      continue;
    }

    const allowed = ALLOWED_ATTRS[tag] ?? new Set<string>();
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();

      if (!allowed.has(name)) {
        element.removeAttribute(attribute.name);
        continue;
      }
      // Even an allow-listed href must survive the scheme check.
      if (name === 'href' && !safeUrl(attribute.value)) {
        element.removeAttribute(attribute.name);
      }
    }
  }

  // Unwrap disallowed elements rather than deleting their text.
  for (const element of doomed) {
    const parent = element.parentNode;
    if (!parent) continue;
    while (element.firstChild) parent.insertBefore(element.firstChild, element);
    parent.removeChild(element);
  }

  return template.innerHTML;
}

/** Render markdown to sanitised HTML, ready for `dangerouslySetInnerHTML`. */
export function renderMarkdown(source: string): string {
  if (!source) return '';
  try {
    return sanitize(marked.parse(source) as string);
  } catch {
    // Malformed markdown must never blank the transcript.
    return `<p>${escapeHtml(source)}</p>`;
  }
}

/* -------------------------------------------------------------------------- */
/* Notes                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The note renderer's per-parse resolver. Module state is safe here because
 * `parse` is synchronous and `renderNoteMarkdown` is the only writer.
 */
let noteResolver: ((target: string) => string | null) | null = null;

/**
 * A separate `Marked` instance, so wikilinks exist only where notes render:
 * the transcript's `[[…]]` stays the literal text the model wrote.
 * The tokenizer runs before code spans are re-parsed, but marked tokenises
 * fences and inline code first — a wikilink inside code never reaches it.
 */
const noteMarked = new Marked();
noteMarked.setOptions({ renderer, gfm: true, breaks: true, async: false });
noteMarked.use({
  extensions: [
    {
      name: 'wikilink',
      level: 'inline',
      start(src: string) {
        const at = src.indexOf('[[');
        return at < 0 ? undefined : at;
      },
      tokenizer(src: string) {
        const match = /^\[\[([^[\]]+)\]\]/.exec(src);
        if (!match) return undefined;
        const inner = match[1]!;
        const target = inner.split('|')[0]!.split('#')[0]!.trim();
        const alias = inner.includes('|') ? inner.slice(inner.indexOf('|') + 1).trim() : '';
        if (!target) return undefined;
        return { type: 'wikilink', raw: match[0], target, label: alias || inner.trim() };
      },
      renderer(token) {
        const { target, label } = token as unknown as { target: string; label: string };
        const resolved = noteResolver?.(target) ?? null;
        if (!resolved) {
          return `<span class="wikilink-missing" title="No note with this name yet">${escapeHtml(label)}</span>`;
        }
        // href="#" keeps it a real, focusable link; the preview intercepts the
        // click and opens `data-note` in the panel instead of navigating.
        return `<a href="#" class="wikilink" data-note="${escapeHtml(resolved)}">${escapeHtml(label)}</a>`;
      },
    },
  ],
});

/**
 * Render a note to sanitised HTML, wikilinks resolved through `resolve`.
 * Same sanitiser as the transcript: note content is whatever an agent or a
 * synced vault put on disk, and is trusted exactly as far.
 */
export function renderNoteMarkdown(
  source: string,
  resolve: (target: string) => string | null,
): string {
  if (!source) return '';
  noteResolver = resolve;
  try {
    return sanitize(noteMarked.parse(source) as string);
  } catch {
    return `<p>${escapeHtml(source)}</p>`;
  } finally {
    noteResolver = null;
  }
}
