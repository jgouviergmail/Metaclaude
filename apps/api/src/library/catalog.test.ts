import { describe, expect, it } from 'vitest';

import { LIBRARY_CATEGORIES } from '@metaclaude/shared';

import { LIBRARY } from './catalog.js';

// The registry's own name rule, duplicated on purpose: the library's promise
// is that every entry INSTALLS, so the test must fail the day either side
// drifts — a looser catalogue or a stricter registry.
const REGISTRY_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

describe('the built-in library catalogue', () => {
  it('has entries of both kinds', () => {
    expect(LIBRARY.some((entry) => entry.kind === 'agent')).toBe(true);
    expect(LIBRARY.some((entry) => entry.kind === 'skill')).toBe(true);
  });

  it('names every entry uniquely, across kinds', () => {
    // Install is addressed by name alone, so a skill and an agent may not
    // share one — uniqueness within each kind is not enough.
    const names = LIBRARY.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('names every entry so the registry will accept it', () => {
    for (const entry of LIBRARY) {
      expect(entry.name, `"${entry.name}" would be refused by the registry`).toMatch(REGISTRY_NAME);
    }
  });

  it('keeps every category inside the shared vocabulary', () => {
    // The field is typed, but a cast or a vocabulary change slips past the
    // compiler; the runtime check is what the install path relies on.
    for (const entry of LIBRARY) {
      expect(LIBRARY_CATEGORIES, `"${entry.name}" claims category "${entry.category}"`).toContain(
        entry.category,
      );
    }
  });

  it('covers every category with at least one entry', () => {
    // The UI filters by category chip; a chip that matches nothing reads as
    // broken, so the shelf must stock each shelf label it shows.
    const covered = new Set(LIBRARY.map((entry) => entry.category));
    for (const category of LIBRARY_CATEGORIES) {
      expect(covered, `no library entry in category "${category}"`).toContain(category);
    }
  });

  it('describes every entry in one line, substantial but short', () => {
    for (const entry of LIBRARY) {
      expect(entry.description, entry.name).toBe(entry.description.trim());
      expect(entry.description, entry.name).not.toContain('\n');
      expect(entry.description.length, `${entry.name}: description too thin`).toBeGreaterThanOrEqual(40);
      expect(entry.description.length, `${entry.name}: description is an essay`).toBeLessThanOrEqual(200);
    }
  });

  it('gives every agent a working prompt, not a slogan', () => {
    for (const entry of LIBRARY) {
      if (entry.kind !== 'agent') continue;
      expect(entry.prompt.trim().length, entry.name).toBeGreaterThanOrEqual(300);
    }
  });

  it('writes every skill as a markdown procedure with a definition of done', () => {
    for (const entry of LIBRARY) {
      if (entry.kind !== 'skill') continue;
      // materialiseSkills prepends frontmatter and writes the body verbatim,
      // so the body must open as a document, not mid-sentence.
      expect(entry.body.startsWith('# '), `${entry.name}: body must open with a heading`).toBe(true);
      expect(entry.body.trim().length, entry.name).toBeGreaterThanOrEqual(300);
      expect(entry.body, `${entry.name}: a skill needs its definition of done`).toContain('Done when:');
    }
  });
});
