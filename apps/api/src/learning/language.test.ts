/**
 * Which language the system writes in, and where that decision comes from.
 *
 * Two settings and one rule, and the rule is what is worth pinning: a
 * workspace that has said nothing follows the deployment, and a workspace that
 * has said something is never overruled by it. Everything below is about
 * *generated* text — memories, distilled lessons, a merged note — not about
 * the interface, which is a per-browser preference and has no business
 * deciding what a shared corpus is written in.
 */

import { describe, expect, it } from 'vitest';
import { contentLanguageDirective, resolveContentLanguage } from './language.js';

describe('resolveContentLanguage', () => {
  it('follows the workspace when it has an opinion', () => {
    expect(resolveContentLanguage('fr', 'en')).toBe('fr');
    expect(resolveContentLanguage('en', 'fr')).toBe('en');
    expect(resolveContentLanguage('fr', 'auto')).toBe('fr');
  });

  /**
   * `auto` is the default on every workspace ever created, so this is the
   * common case rather than the fallback: production ran a French deployment
   * whose only workspace was `auto`, and every memory it distilled came back
   * in English.
   */
  it('falls back to the deployment when the workspace says auto', () => {
    expect(resolveContentLanguage('auto', 'fr')).toBe('fr');
    expect(resolveContentLanguage('auto', 'en')).toBe('en');
  });

  /** Both silent is the old behaviour exactly: no directive at all. */
  it('answers null when neither has an opinion', () => {
    expect(resolveContentLanguage('auto', 'auto')).toBeNull();
  });
});

describe('contentLanguageDirective', () => {
  it('says nothing when there is nothing to say', () => {
    expect(contentLanguageDirective(null)).toBe('');
  });

  it('names the language, and says it governs the values rather than the shape', () => {
    const fr = contentLanguageDirective('fr');
    expect(fr).toContain('French');
    // The call is schema-constrained: translating the field *names* would make
    // the answer unparseable, and a model told only "write in French" has been
    // known to try.
    expect(fr).toMatch(/field name|key/i);
  });

  it('exempts what must not be translated', () => {
    const directive = contentLanguageDirective('fr');
    // A lesson whose whole value is `pnpm test:run` is worthless translated.
    expect(directive).toMatch(/command|identifier|path/i);
  });

  it('answers in English for English', () => {
    expect(contentLanguageDirective('en')).toContain('English');
    expect(contentLanguageDirective('en')).not.toContain('French');
  });
});
